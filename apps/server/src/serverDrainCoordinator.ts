import * as NodeCrypto from "node:crypto";

import {
  ServerDrainControlError,
  ServerDrainingError,
  ServerDrainSnapshot as ServerDrainSnapshotSchema,
  type ServerDrainControlInput,
  type ServerDrainSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const INTERACTIVE_DRAIN_DEADLINE = Duration.seconds(30);
const PROCESS_EXIT_DRAIN_DEADLINE = Duration.seconds(5);
const encodeServerDrainSnapshot = Schema.encodeEffect(
  Schema.fromJsonString(ServerDrainSnapshotSchema),
);

import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "./orchestration/Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "./orchestration/Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "./orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { SessionReconciler } from "./provider/Services/SessionReconciler.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";

export class ServerDrainCoordinator extends Context.Service<
  ServerDrainCoordinator,
  {
    readonly control: (
      input: ServerDrainControlInput,
    ) => Effect.Effect<ServerDrainSnapshot | null, ServerDrainControlError>;
    readonly snapshot: Effect.Effect<ServerDrainSnapshot | null>;
    readonly assertTurnAdmission: Effect.Effect<void, ServerDrainingError>;
    readonly admitTurn: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ServerDrainingError, R>;
    readonly awaitCommit: (
      drainId: string,
    ) => Effect.Effect<ServerDrainSnapshot, ServerDrainControlError>;
    readonly completeStartupReconciliation: Effect.Effect<void>;
    readonly clearFailedUpdateDrain: Effect.Effect<void>;
    readonly drainForProcessExit: Effect.Effect<void>;
  }
>()("t3/serverDrainCoordinator") {}

const controlError = (reason: ServerDrainControlError["reason"], message: string) =>
  new ServerDrainControlError({ reason, message });

export const make = (options?: { readonly installProcessFinalizer?: boolean }) =>
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    const lifecycle = yield* ServerLifecycleEvents;
    const reconciler = yield* SessionReconciler;
    const engine = yield* OrchestrationEngineService;
    const sql = yield* SqlClient.SqlClient;
    const serviceScope = yield* Effect.scope;
    const checkpointReactor = yield* Effect.serviceOption(CheckpointReactor);
    const providerCommandReactor = yield* Effect.serviceOption(ProviderCommandReactor);
    const providerRuntimeIngestion = yield* Effect.serviceOption(ProviderRuntimeIngestionService);
    const state = yield* Ref.make<ServerDrainSnapshot | null>(null);
    const mutex = yield* Semaphore.make(1);
    const commitWaiters = yield* Ref.make(
      new Map<string, Deferred.Deferred<ServerDrainSnapshot, ServerDrainControlError>>(),
    );

    const signalCommitted = (snapshot: ServerDrainSnapshot) =>
      Ref.get(commitWaiters).pipe(
        Effect.flatMap((waiters) => {
          const waiter = waiters.get(snapshot.id);
          return waiter === undefined
            ? Effect.void
            : Deferred.succeed(waiter, snapshot).pipe(Effect.asVoid);
        }),
      );

    const deriveWork = Effect.gen(function* () {
      const shell = yield* snapshots.getShellSnapshot();
      const active = shell.threads.filter(
        (thread) => thread.session?.status === "starting" || thread.session?.status === "running",
      );
      return {
        activeWorkCount: active.length,
        blockedThreadIds: active
          .filter((thread) => thread.hasPendingApprovals || thread.hasPendingUserInput)
          .map((thread) => thread.id),
      };
    });

    const publish = (next: ServerDrainSnapshot | null) =>
      (next === null
        ? sql`DELETE FROM server_drain_state WHERE singleton_id = 1`
        : encodeServerDrainSnapshot(next).pipe(
            Effect.flatMap(
              (snapshotJson) => sql`
            INSERT INTO server_drain_state (singleton_id, snapshot_json)
            VALUES (1, ${snapshotJson})
            ON CONFLICT (singleton_id) DO UPDATE SET snapshot_json = excluded.snapshot_json
          `,
            ),
          )
      ).pipe(
        Effect.mapError(() =>
          controlError("persistence-failed", "Could not persist the server drain state."),
        ),
        Effect.andThen(Ref.set(state, next)),
        Effect.andThen(lifecycle.setDrain(next ?? undefined)),
        Effect.asVoid,
      );

    const drainProviderCommands = Option.match(providerCommandReactor, {
      onNone: () => Effect.void,
      onSome: ({ drain }) => drain,
    });
    const drainProviderRuntime = Option.match(providerRuntimeIngestion, {
      onNone: () => Effect.void,
      onSome: ({ drain }) => drain,
    });
    const drainCheckpoints = Option.match(checkpointReactor, {
      onNone: () => Effect.void,
      onSome: ({ drain }) => drain,
    });
    // Provider commands are producers for runtime ingestion, whose orchestration
    // receipts in turn feed checkpoint work. Preserve that dependency order so
    // an empty downstream queue cannot be observed before its producer settles.
    const establishProviderQuiescence = drainProviderCommands.pipe(
      Effect.andThen(drainProviderRuntime),
      Effect.andThen(drainCheckpoints),
    );

    const commitUnderLease = (current: ServerDrainSnapshot) =>
      Effect.gen(function* () {
        const committing = { ...current, phase: "committing" as const, canCancel: false };
        yield* publish(committing);
        yield* establishProviderQuiescence;
        yield* reconciler.interruptActiveSessions.pipe(
          Effect.mapError(() =>
            controlError("persistence-failed", "Could not durably interrupt active work."),
          ),
        );
        yield* establishProviderQuiescence;
        const remaining = yield* deriveWork.pipe(
          Effect.mapError(() =>
            controlError("persistence-failed", "Could not verify durable session shutdown."),
          ),
        );
        const completed = {
          ...committing,
          ...remaining,
          canForce: remaining.activeWorkCount > 0,
        };
        yield* publish(completed);
        if (remaining.activeWorkCount === 0) yield* signalCommitted(completed);
        return completed;
      });

    const refresh = mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current === null || current.phase === "committing") return;
        const work = yield* deriveWork;
        const next: ServerDrainSnapshot = {
          ...current,
          ...work,
          phase: work.activeWorkCount === 0 ? "committing" : current.phase,
          canCancel: work.activeWorkCount === 0 ? false : current.canCancel,
        };
        if (
          next.phase !== current.phase ||
          next.activeWorkCount !== current.activeWorkCount ||
          next.blockedThreadIds.join("\u0000") !== current.blockedThreadIds.join("\u0000")
        ) {
          if (next.phase === "committing") yield* commitUnderLease(next);
          else yield* publish(next);
        }
      }),
    );

    yield* engine.streamDomainEvents.pipe(
      Stream.runForEach(() => refresh.pipe(Effect.ignoreCause({ log: true }))),
      Effect.forkScoped,
    );

    const control: ServerDrainCoordinator["Service"]["control"] = (input) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (input.operation === "begin") {
            if (current !== null) {
              return yield* controlError("already-draining", "The server is already draining.");
            }
            // The admission mutex is already closed. Flush provider mutations
            // whose orchestration commands committed before this drain acquired
            // the lease, so none can begin a replacement after the drain is
            // published.
            yield* establishProviderQuiescence;
            const work = yield* deriveWork.pipe(
              Effect.mapError(() =>
                controlError("persistence-failed", "Could not read active session state."),
              ),
            );
            const next: ServerDrainSnapshot = {
              id: NodeCrypto.randomUUID(),
              action: input.action,
              phase: work.activeWorkCount === 0 ? "committing" : "draining",
              ...work,
              canCancel: work.activeWorkCount > 0,
              canForce: work.activeWorkCount > 0,
              requestedAt: DateTime.formatIso(yield* DateTime.now),
            };
            const waiter = yield* Deferred.make<ServerDrainSnapshot, ServerDrainControlError>();
            yield* Ref.update(commitWaiters, (waiters) => new Map(waiters).set(next.id, waiter));
            if (next.phase === "committing") yield* commitUnderLease(next);
            else {
              yield* publish(next);
              yield* Effect.sleep(INTERACTIVE_DRAIN_DEADLINE).pipe(
                Effect.andThen(
                  mutex.withPermits(1)(
                    Ref.get(state).pipe(
                      Effect.flatMap((latest) =>
                        latest?.id === next.id && latest.phase === "draining"
                          ? publish({ ...latest, phase: "action-required" })
                          : Effect.void,
                      ),
                    ),
                  ),
                ),
                Effect.forkIn(serviceScope),
              );
            }
            return next;
          }
          if (current === null) {
            return yield* controlError("not-draining", "The server is not draining.");
          }
          if (current.id !== input.drainId) {
            return yield* controlError("drain-mismatch", "The drain request is no longer current.");
          }
          if (input.operation === "cancel") {
            if (current.phase === "committing") {
              return yield* controlError("already-committing", "Shutdown is already committing.");
            }
            const waiter = (yield* Ref.get(commitWaiters)).get(current.id);
            if (waiter !== undefined) {
              yield* Deferred.fail(
                waiter,
                controlError("not-draining", "The shutdown request was cancelled."),
              );
            }
            yield* publish(null);
            return null;
          }

          return yield* commitUnderLease(current);
        }),
      );

    const drainForProcessExit = Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const drain = current ?? (yield* control({ operation: "begin", action: "shutdown" }));
      if (drain === null || drain.phase === "committing") return;
      yield* Effect.raceFirst(
        awaitCommitEffect(drain.id).pipe(Effect.asVoid),
        Effect.sleep(PROCESS_EXIT_DRAIN_DEADLINE).pipe(
          Effect.andThen(control({ operation: "force", drainId: drain.id })),
          Effect.asVoid,
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("safe shutdown reconciliation failed", { cause }),
      ),
    );

    if (options?.installProcessFinalizer !== false) {
      yield* Effect.addFinalizer(() => drainForProcessExit);
    }

    const admitTurn = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | ServerDrainingError, R> =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const drain = yield* Ref.get(state);
          if (drain !== null) return yield* new ServerDrainingError({ drain });
          return yield* effect;
        }),
      );

    function awaitCommitEffect(drainId: string) {
      return Ref.get(commitWaiters).pipe(
        Effect.flatMap((waiters) => {
          const waiter = waiters.get(drainId);
          return waiter === undefined
            ? Effect.fail(controlError("drain-mismatch", "The drain request is no longer current."))
            : Deferred.await(waiter);
        }),
      );
    }

    return {
      control,
      snapshot: Ref.get(state),
      assertTurnAdmission: Ref.get(state).pipe(
        Effect.flatMap((drain) =>
          drain === null ? Effect.void : Effect.fail(new ServerDrainingError({ drain })),
        ),
      ),
      admitTurn,
      awaitCommit: awaitCommitEffect,
      drainForProcessExit,
      completeStartupReconciliation: sql`
      DELETE FROM server_drain_state WHERE singleton_id = 1
    `.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to clear reconciled drain state", { cause }),
        ),
        Effect.asVoid,
      ),
      clearFailedUpdateDrain: mutex.withPermits(1)(
        Ref.get(state).pipe(
          Effect.flatMap((current) => (current?.action === "update" ? publish(null) : Effect.void)),
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to clear update drain state", { cause }),
          ),
        ),
      ),
    } satisfies ServerDrainCoordinator["Service"];
  });

export const layer = Layer.effect(ServerDrainCoordinator, make());
export const layerTest = Layer.effect(
  ServerDrainCoordinator,
  make({ installProcessFinalizer: false }),
);
