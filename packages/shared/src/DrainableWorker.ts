/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps the common `Queue.unbounded` + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * @module DrainableWorker
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;
}

export class DrainableWorkerClosedError extends Schema.TaggedErrorClass<DrainableWorkerClosedError>()(
  "DrainableWorkerClosedError",
  {},
) {
  override get message(): string {
    return "Drainable worker is closed.";
  }
}

export interface KeyedDrainableWorker<A> {
  /** Enqueue an item while admission is open. */
  readonly enqueue: (item: A) => Effect.Effect<void, DrainableWorkerClosedError>;

  /** Wait for every item admitted before this effect starts. */
  readonly drain: Effect.Effect<void>;

  /** Close admission, drain the closing snapshot, and stop the worker fibers. */
  readonly shutdown: Effect.Effect<void>;
}

interface ListNode<A> {
  readonly value: A;
  readonly next: ListNode<A> | null;
}

interface PendingQueue<A> {
  readonly front: ListNode<A> | null;
  readonly back: ListNode<A> | null;
}

interface SequencedItem<A> {
  readonly sequence: number;
  readonly item: A;
}

interface DrainWaiter {
  readonly cutoff: number;
  readonly remaining: number;
  readonly deferred: Deferred.Deferred<void>;
}

interface KeyedDrainableWorkerState<K, A> {
  readonly admissionOpen: boolean;
  readonly shutdownCutoff: number | null;
  readonly admittedThrough: number;
  readonly outstanding: number;
  readonly drainWaiters: Map<object, DrainWaiter>;
  readonly pendingByKey: Map<K, PendingQueue<SequencedItem<A>>>;
  readonly readyKeys: Set<K>;
  readonly activeKeys: Set<K>;
}

const appendPending = <A>(queue: PendingQueue<A> | undefined, value: A): PendingQueue<A> => ({
  front: queue?.front ?? null,
  back: { value, next: queue?.back ?? null },
});

function reverseList<A>(list: ListNode<A> | null): ListNode<A> | null {
  let source = list;
  let reversed: ListNode<A> | null = null;
  while (source !== null) {
    reversed = { value: source.value, next: reversed };
    source = source.next;
  }
  return reversed;
}

function takePending<A>(
  queue: PendingQueue<A>,
): readonly [value: A, remaining: PendingQueue<A>] | null {
  const front = queue.front ?? reverseList(queue.back);
  if (front === null) {
    return null;
  }
  return [
    front.value,
    {
      front: front.next,
      back: queue.front === null ? null : queue.back,
    },
  ];
}

const hasPending = <A>(queue: PendingQueue<A>): boolean =>
  queue.front !== null || queue.back !== null;

/**
 * Create a drainable worker that processes items from an unbounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), TxQueue.shutdown);
    const outstanding = yield* TxRef.make(0);

    yield* TxQueue.take(queue).pipe(
      Effect.tap((a) =>
        Effect.ensuring(
          process(a),
          TxRef.update(outstanding, (n) => n - 1),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap(() => TxRef.update(outstanding, (n) => n + 1)),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });

/**
 * Create a bounded-concurrency worker that preserves FIFO order per key.
 *
 * A key returns to the tail of the ready-key queue after each item, so busy
 * keys cannot monopolize capacity. `drain` snapshots the current admission
 * sequence; `shutdown` closes admission atomically before draining its cutoff.
 */
export const makeKeyedDrainableWorker = Effect.fn("makeKeyedDrainableWorker")(function* <
  A,
  K,
  E,
  R,
>(options: {
  readonly concurrency: number;
  readonly key: (item: A) => K;
  readonly process: (item: A) => Effect.Effect<void, E, R>;
}): Effect.fn.Return<KeyedDrainableWorker<A>, never, Scope.Scope | R> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    return yield* Effect.die(
      new RangeError("makeKeyedDrainableWorker concurrency must be a positive integer"),
    );
  }

  const readyQueue = yield* TxQueue.unbounded<K>();
  const shutdownComplete = yield* Deferred.make<void>();
  const workerScope = yield* Scope.make("sequential");
  const stateRef = yield* TxRef.make<KeyedDrainableWorkerState<K, A>>({
    admissionOpen: true,
    shutdownCutoff: null,
    admittedThrough: 0,
    outstanding: 0,
    drainWaiters: new Map(),
    pendingByKey: new Map(),
    readyKeys: new Set(),
    activeKeys: new Set(),
  });

  const claimReadyItem = Effect.gen(function* () {
    const key = yield* TxQueue.take(readyQueue);
    const state = yield* TxRef.get(stateRef);
    const readyKeys = new Set(state.readyKeys);
    readyKeys.delete(key);

    const queue = state.pendingByKey.get(key);
    const taken = queue ? takePending(queue) : null;
    if (taken === null || state.activeKeys.has(key)) {
      yield* TxRef.set(stateRef, { ...state, readyKeys });
      return null;
    }

    const [work, remaining] = taken;
    const pendingByKey = new Map(state.pendingByKey);
    if (hasPending(remaining)) {
      pendingByKey.set(key, remaining);
    } else {
      pendingByKey.delete(key);
    }
    const activeKeys = new Set(state.activeKeys);
    activeKeys.add(key);
    yield* TxRef.set(stateRef, {
      ...state,
      pendingByKey,
      readyKeys,
      activeKeys,
    });
    return { key, work } as const;
  }).pipe(Effect.tx);

  const retireItem = (key: K, sequence: number) => {
    const updateState = Effect.gen(function* () {
      const state = yield* TxRef.get(stateRef);
      const activeKeys = new Set(state.activeKeys);
      activeKeys.delete(key);
      const readyKeys = new Set(state.readyKeys);
      const shouldSchedule = state.pendingByKey.has(key) && !readyKeys.has(key);
      if (shouldSchedule) {
        readyKeys.add(key);
      }
      const drainWaiters = new Map(state.drainWaiters);
      const completedWaiters: Array<Deferred.Deferred<void>> = [];
      for (const [token, waiter] of drainWaiters) {
        if (sequence > waiter.cutoff) {
          continue;
        }
        if (waiter.remaining === 1) {
          drainWaiters.delete(token);
          completedWaiters.push(waiter.deferred);
        } else {
          drainWaiters.set(token, { ...waiter, remaining: waiter.remaining - 1 });
        }
      }
      yield* TxRef.set(stateRef, {
        ...state,
        outstanding: state.outstanding - 1,
        drainWaiters,
        readyKeys,
        activeKeys,
      });
      if (shouldSchedule) {
        yield* TxQueue.offer(readyQueue, key);
      }
      return completedWaiters;
    }).pipe(Effect.tx);

    return updateState.pipe(
      Effect.flatMap((completedWaiters) =>
        Effect.forEach(completedWaiters, (deferred) => Deferred.succeed(deferred, undefined), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    );
  };

  const runWorker = Effect.forever(
    claimReadyItem.pipe(
      Effect.flatMap((claimed) => {
        if (claimed === null) {
          return Effect.void;
        }
        return options.process(claimed.work.item).pipe(
          Effect.catch(() => Effect.void),
          Effect.ensuring(retireItem(claimed.key, claimed.work.sequence)),
        );
      }),
    ),
  );

  yield* Effect.forEach(
    Array.from({ length: options.concurrency }),
    () => runWorker.pipe(Effect.forkIn(workerScope, { startImmediately: true })),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);

  const enqueue: KeyedDrainableWorker<A>["enqueue"] = (item) =>
    Effect.gen(function* () {
      const state = yield* TxRef.get(stateRef);
      if (!state.admissionOpen) {
        return yield* new DrainableWorkerClosedError();
      }

      const key = options.key(item);
      const sequence = state.admittedThrough + 1;
      const pendingByKey = new Map(state.pendingByKey);
      pendingByKey.set(
        key,
        appendPending(pendingByKey.get(key), {
          sequence,
          item,
        }),
      );
      const readyKeys = new Set(state.readyKeys);
      const shouldSchedule = !state.activeKeys.has(key) && !readyKeys.has(key);
      if (shouldSchedule) {
        readyKeys.add(key);
      }
      yield* TxRef.set(stateRef, {
        ...state,
        admittedThrough: sequence,
        outstanding: state.outstanding + 1,
        pendingByKey,
        readyKeys,
      });
      if (shouldSchedule) {
        yield* TxQueue.offer(readyQueue, key);
      }
    }).pipe(Effect.tx);

  const drain: KeyedDrainableWorker<A>["drain"] = Effect.gen(function* () {
    const token = {};
    const deferred = yield* Deferred.make<void>();
    const shouldWait = yield* Effect.gen(function* () {
      const state = yield* TxRef.get(stateRef);
      if (state.outstanding === 0) {
        return false;
      }
      const drainWaiters = new Map(state.drainWaiters);
      drainWaiters.set(token, {
        cutoff: state.admittedThrough,
        remaining: state.outstanding,
        deferred,
      });
      yield* TxRef.set(stateRef, { ...state, drainWaiters });
      return true;
    }).pipe(Effect.tx);
    if (!shouldWait) {
      return;
    }
    yield* Deferred.await(deferred).pipe(
      Effect.ensuring(
        TxRef.update(stateRef, (state) => {
          if (!state.drainWaiters.has(token)) {
            return state;
          }
          const drainWaiters = new Map(state.drainWaiters);
          drainWaiters.delete(token);
          return { ...state, drainWaiters };
        }).pipe(Effect.tx),
      ),
    );
  });

  const shutdown: KeyedDrainableWorker<A>["shutdown"] = Effect.uninterruptible(
    Effect.gen(function* () {
      const isLeader = yield* Effect.gen(function* () {
        const state = yield* TxRef.get(stateRef);
        if (state.shutdownCutoff !== null) {
          return false;
        }
        yield* TxRef.set(stateRef, {
          ...state,
          admissionOpen: false,
          shutdownCutoff: state.admittedThrough,
        });
        return true;
      }).pipe(Effect.tx);

      if (!isLeader) {
        yield* Deferred.await(shutdownComplete);
        return;
      }

      yield* drain;
      yield* Scope.close(workerScope, Exit.void);
      yield* TxQueue.shutdown(readyQueue);
      yield* Deferred.succeed(shutdownComplete, undefined);
    }),
  );

  yield* Effect.addFinalizer(() => shutdown);
  return { enqueue, drain, shutdown } satisfies KeyedDrainableWorker<A>;
});
