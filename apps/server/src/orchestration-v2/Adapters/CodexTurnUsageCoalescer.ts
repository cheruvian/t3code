import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

interface PendingUsage<V> {
  readonly lock: Semaphore.Semaphore;
  value: Option.Option<V>;
  worker: { readonly token: object; readonly fiber: Fiber.Fiber<void> } | null;
}

/** Child usage is a replaceable snapshot; separate workers keep children independent. */
export const makeCodexTurnUsageCoalescer = Effect.fn("makeCodexTurnUsageCoalescer")(function* <
  V,
>(input: { readonly emit: (value: V) => Effect.Effect<void> }) {
  const keys = new Map<string, PendingUsage<V>>();
  const registryLock = yield* Semaphore.make(1);
  const workers = yield* Scope.make("parallel");
  const closeDone = yield* Deferred.make<void>();
  let closed = false;

  const emitLatest = Effect.fn("emitLatest")(function* (state: PendingUsage<V>) {
    if (Option.isSome(state.value)) {
      yield* input.emit(state.value.value);
      state.value = Option.none();
    }
  });
  const close = Effect.uninterruptible(
    Effect.gen(function* () {
      if (closed) return yield* Deferred.await(closeDone);
      closed = true;
      yield* Scope.close(workers, Exit.void);
      keys.clear();
      yield* Deferred.succeed(closeDone, undefined);
    }),
  );
  yield* Effect.addFinalizer(() => close);

  return {
    offer: (key: string, value: V) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const state = yield* registryLock.withPermit(
            Effect.gen(function* () {
              if (closed) return null;
              const existing = keys.get(key);
              if (existing !== undefined) return existing;
              const state: PendingUsage<V> = {
                lock: yield* Semaphore.make(1),
                value: Option.none(),
                worker: null,
              };
              keys.set(key, state);
              return state;
            }),
          );
          if (state === null) return;
          yield* state.lock.withPermit(
            Effect.gen(function* () {
              if (closed) return;
              state.value = Option.some(value);
              if (state.worker !== null) return;
              const token = {};
              const fiber = yield* Effect.sleep("250 millis").pipe(
                Effect.andThen(
                  state.lock.withPermit(
                    Effect.gen(function* () {
                      if (!closed && state.worker?.token === token) yield* emitLatest(state);
                    }).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          if (state.worker?.token === token) state.worker = null;
                        }),
                      ),
                    ),
                  ),
                ),
                Effect.interruptible,
                Effect.forkIn(workers, { startImmediately: true }),
              );
              state.worker = { token, fiber };
            }),
          );
        }),
      ),
    flush: Effect.fn("flush")(function* (key: string) {
      const state = keys.get(key);
      if (state === undefined || closed) return;
      let worker: Fiber.Fiber<void> | null = null;
      yield* state.lock
        .withPermit(
          Effect.gen(function* () {
            if (closed) return;
            worker = state.worker?.fiber ?? null;
            state.worker = null;
            yield* emitLatest(state);
          }),
        )
        .pipe(
          Effect.ensuring(
            Effect.suspend(() => (worker === null ? Effect.void : Fiber.interrupt(worker))),
          ),
        );
    }),
    close,
  };
});
