import {
  CommandId,
  ServerDrainControlError,
  type ServerDrainControlInput,
  ServerDrainSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerDrainAdmission } from "./serverDrainAdmission.ts";
import { OrchestratorV2 } from "./orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "./orchestration-v2/ProjectionStore.ts";
import { OrchestrationEffectWorkerV2 } from "./orchestration-v2/EffectWorker.ts";

const failure = (message: string) =>
  new ServerDrainControlError({ reason: "persistence-failed", message });
const mapFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(() => failure("Could not reconcile active work for shutdown.")));

export interface DrainWork {
  readonly read: Effect.Effect<
    {
      readonly threadIds: ReadonlyArray<ThreadId>;
      readonly blockedThreadIds: ReadonlyArray<ThreadId>;
    },
    ServerDrainControlError
  >;
  readonly flush: Effect.Effect<void, ServerDrainControlError>;
  readonly stop: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<void, ServerDrainControlError>;
  readonly save: (
    snapshot: ServerDrainSnapshot | null,
  ) => Effect.Effect<void, ServerDrainControlError>;
  readonly changes: Stream.Stream<unknown, ServerDrainControlError>;
  readonly resume: Effect.Effect<void, ServerDrainControlError>;
}

export class ServerDrainCoordinator extends Context.Service<
  ServerDrainCoordinator,
  {
    readonly control: (
      input: ServerDrainControlInput,
    ) => Effect.Effect<ServerDrainSnapshot | null, ServerDrainControlError>;
    readonly awaitCommit: (
      drainId: string,
    ) => Effect.Effect<ServerDrainSnapshot, ServerDrainControlError>;
    readonly awaitReady: (
      action: ServerDrainSnapshot["action"],
    ) => Effect.Effect<ServerDrainSnapshot, ServerDrainControlError>;
    readonly clear: Effect.Effect<void, ServerDrainControlError>;
    readonly stream: Stream.Stream<ServerDrainSnapshot | null>;
    readonly drainForProcessExit: Effect.Effect<void, ServerDrainControlError>;
  }
>()("t3/serverDrainCoordinator") {}

export const make = Effect.fn("ServerDrainCoordinator.make")(function* (work: DrainWork) {
  const admission = yield* ServerDrainAdmission;
  const random = yield* SecureRandom.SecureRandom;
  const scope = yield* Effect.scope;
  const mutex = yield* Semaphore.make(1);
  const state = yield* SubscriptionRef.make<ServerDrainSnapshot | null>(null);
  let waiter: Deferred.Deferred<ServerDrainSnapshot, ServerDrainControlError> | undefined;
  yield* work.save(null);

  const publish = Effect.fn("ServerDrainCoordinator.publish")(function* (
    snapshot: ServerDrainSnapshot | null,
  ) {
    yield* work.save(snapshot);
    yield* SubscriptionRef.set(state, snapshot);
    if (snapshot?.phase === "committing" && snapshot.activeWorkCount === 0 && waiter) {
      yield* Deferred.succeed(waiter, snapshot);
    }
  });
  const readCounts = work.read.pipe(
    Effect.map((work) => ({
      activeWorkCount: work.threadIds.length,
      blockedThreadIds: work.blockedThreadIds,
    })),
  );
  const refresh = mutex.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);
      if (current === null) return;
      const counts = yield* readCounts;
      const next = {
        ...current,
        ...counts,
        ...(counts.activeWorkCount === 0
          ? { phase: "committing" as const, canCancel: false, canForce: false }
          : {}),
      };
      if (
        current.phase !== next.phase ||
        current.activeWorkCount !== next.activeWorkCount ||
        current.blockedThreadIds.join("\0") !== next.blockedThreadIds.join("\0")
      )
        yield* publish(next);
    }),
  );
  yield* work.changes.pipe(
    Stream.runForEach(() => refresh.pipe(Effect.ignoreCause({ log: true }))),
    Effect.forkScoped,
  );

  const clear = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        yield* publish(null);
        yield* admission.open;
      }),
    )
    .pipe(Effect.andThen(work.resume));
  const control = Effect.fn("ServerDrainCoordinator.control")(function* (
    input: ServerDrainControlInput,
  ) {
    const result = yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (input.operation === "begin") {
          if (current !== null)
            return yield* new ServerDrainControlError({
              reason: "already-draining",
              message: "A shutdown or update is already waiting.",
            });
          yield* admission.close;
          return yield* Effect.gen(function* () {
            const counts = yield* readCounts;
            const next: ServerDrainSnapshot = {
              id: yield* random
                .uuidV4()
                .pipe(Effect.mapError(() => failure("Could not allocate a drain request."))),
              action: input.action,
              phase: counts.activeWorkCount === 0 ? "committing" : "draining",
              ...counts,
              canCancel: counts.activeWorkCount > 0,
              canForce: counts.activeWorkCount > 0,
              requestedAt: DateTime.formatIso(yield* DateTime.now),
            };
            waiter = yield* Deferred.make<ServerDrainSnapshot, ServerDrainControlError>();
            yield* publish(next);
            if (next.phase === "draining")
              yield* Effect.sleep(Duration.seconds(30)).pipe(
                Effect.andThen(
                  mutex.withPermits(1)(
                    Effect.gen(function* () {
                      const latest = yield* SubscriptionRef.get(state);
                      if (latest?.id === next.id && latest.phase === "draining")
                        yield* publish({ ...latest, phase: "action-required" });
                    }),
                  ),
                ),
                Effect.forkIn(scope),
              );
            return next;
          }).pipe(Effect.onError(() => admission.open));
        }
        if (current === null || current.id !== input.drainId)
          return yield* new ServerDrainControlError({
            reason: "drain-mismatch",
            message: "This shutdown request is no longer current.",
          });
        if (input.operation === "resume") {
          if (
            current.action !== "update" ||
            current.phase !== "committing" ||
            current.activeWorkCount !== 0
          )
            return yield* new ServerDrainControlError({
              reason: "already-draining",
              message: "Only a failed committed update can resume admission.",
            });
          yield* publish(null);
          yield* admission.open;
          return null;
        }
        if (input.operation === "cancel") {
          if (current.phase === "committing")
            return yield* new ServerDrainControlError({
              reason: "already-committing",
              message: "Shutdown has already committed.",
            });
          yield* publish(null);
          yield* admission.open;
          if (waiter)
            yield* Deferred.fail(
              waiter,
              new ServerDrainControlError({
                reason: "not-draining",
                message: "Shutdown was cancelled.",
              }),
            );
          return null;
        }
        yield* publish({ ...current, phase: "committing", canCancel: false });
        const active = yield* work.read;
        yield* work.stop(active.threadIds);
        yield* work.flush;
        const counts = yield* readCounts;
        const next = {
          ...current,
          ...counts,
          phase: "committing" as const,
          canCancel: false,
          canForce: counts.activeWorkCount > 0,
        };
        yield* publish(next);
        return next;
      }),
    );
    if (input.operation === "cancel" || input.operation === "resume") yield* work.resume;
    return result;
  });
  const awaitCommit = Effect.fn("ServerDrainCoordinator.awaitCommit")(function* (drainId: string) {
    const current = yield* SubscriptionRef.get(state);
    if (current?.id !== drainId || waiter === undefined)
      return yield* new ServerDrainControlError({
        reason: "drain-mismatch",
        message: "This shutdown request is no longer current.",
      });
    return yield* Deferred.await(waiter);
  });
  const awaitReady = Effect.fn("ServerDrainCoordinator.awaitReady")(function* (
    action: ServerDrainSnapshot["action"],
  ) {
    const current = yield* SubscriptionRef.get(state);
    if (current && current.action !== action)
      return yield* new ServerDrainControlError({
        reason: "already-draining",
        message: "Another shutdown action is already waiting.",
      });
    const next = current ?? (yield* control({ operation: "begin", action }));
    if (next === null) return yield* failure("Shutdown request was not created.");
    return yield* awaitCommit(next.id);
  });
  const drainForProcessExit = Effect.gen(function* () {
    const current =
      (yield* SubscriptionRef.get(state)) ??
      (yield* control({ operation: "begin", action: "shutdown" }));
    if (current === null || (current.phase === "committing" && current.activeWorkCount === 0))
      return;
    // Noninteractive process exit is bounded. The runtime's shutdown reconciliation
    // preserves eligible restart continuations; this path must not record a user Stop.
    yield* awaitCommit(current.id).pipe(Effect.timeoutOption("5 seconds"));
  });
  return ServerDrainCoordinator.of({
    control,
    awaitCommit,
    awaitReady,
    clear,
    stream: SubscriptionRef.changes(state),
    drainForProcessExit,
  });
});

export const layer = Layer.effect(
  ServerDrainCoordinator,
  Effect.gen(function* () {
    const engine = yield* OrchestratorV2;
    const worker = yield* OrchestrationEffectWorkerV2;
    const sql = yield* SqlClient.SqlClient;
    const readContext = yield* Effect.context<SqlClient.SqlClient | ProjectionStoreV2>();
    const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(ServerDrainSnapshot));
    const service = yield* make({
      read: readActiveWork.pipe(Effect.provideContext(readContext)),
      flush: mapFailure(worker.drain()).pipe(Effect.asVoid),
      stop: (threadIds) =>
        Effect.forEach(
          threadIds,
          (threadId) =>
            mapFailure(
              engine.dispatch({
                type: "thread.stop",
                threadId,
                commandId: CommandId.make(
                  `drain-stop:${threadId}:${DateTime.formatIso(DateTime.nowUnsafe())}`,
                ),
              }),
            ),
          { discard: true },
        ),
      save: (snapshot) =>
        mapFailure(
          snapshot === null
            ? sql`DELETE FROM server_drain_state WHERE singleton_id = 1`
            : encodeSnapshot(snapshot).pipe(
                Effect.flatMap(
                  (json) =>
                    sql`INSERT OR REPLACE INTO server_drain_state(singleton_id, snapshot_json) VALUES (1, ${json})`,
                ),
              ),
        ).pipe(Effect.asVoid),
      changes: mapDrainChanges(engine.streamDomainEvents),
      resume: mapFailure(engine.resumeQueuedRuns).pipe(Effect.asVoid),
    });
    return service;
  }),
);

/** Read durable runs as well as shell-only background work; shell rows omit silent runs. */
export const readActiveWork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ProjectionStoreV2;
  const active = yield* mapFailure(sql<{ readonly threadId: string }>`
    SELECT DISTINCT thread_id AS "threadId" FROM orchestration_v2_projection_runs
    WHERE status IN ('preparing', 'starting', 'running', 'waiting')
  `);
  const snapshot = yield* mapFailure(store.getShellSnapshot());
  const shells = [...snapshot.threads, ...snapshot.archivedThreads];
  const ids = new Set(active.map((row) => ThreadId.make(row.threadId)));
  for (const thread of shells)
    if ((thread.pendingBackgroundTasks?.length ?? 0) > 0) ids.add(thread.id);
  return {
    threadIds: [...ids],
    blockedThreadIds: shells
      .filter((thread) => ids.has(thread.id) && thread.pendingRuntimeRequest !== null)
      .map((thread) => thread.id),
  };
});

const mapDrainChanges = (events: OrchestratorV2["Service"]["streamDomainEvents"]) =>
  events.pipe(
    Stream.filter((event) =>
      [
        "run.updated",
        "runtime-request.updated",
        "provider-thread.updated",
        "provider-session.updated",
        "turn-item.updated",
      ].includes(event.type),
    ),
    Stream.mapError(() => failure("Shutdown state subscription failed.")),
  );
