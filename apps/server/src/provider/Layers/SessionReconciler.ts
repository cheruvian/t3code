import {
  CommandId,
  type OrchestrationThreadShell,
  type ProviderSessionGeneration,
  type ServerOwnerGeneration,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import {
  SessionReconciler,
  SessionReconciliationError,
  type SessionReconcilerShape,
} from "../Services/SessionReconciler.ts";

export const isActiveShell = (thread: OrchestrationThreadShell) =>
  thread.session?.status === "starting" || thread.session?.status === "running";

export const isOrphanedActiveSession = (
  binding: ProviderRuntimeBinding | undefined,
  ownerGeneration: ServerOwnerGeneration,
) =>
  binding === undefined ||
  binding.status === "stopped" ||
  binding.ownerGeneration === null ||
  binding.ownerGeneration === undefined ||
  binding.ownerGeneration !== ownerGeneration;

const reconciliationCommandId = (
  thread: OrchestrationThreadShell,
  generation: ProviderSessionGeneration | null | undefined,
) =>
  CommandId.make(
    `provider-reconcile:${thread.id}:${generation ?? "legacy"}:${thread.session?.activeTurnId === null ? "stopped" : "interrupted"}`,
  );

export const makeSessionReconciler = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory;
  const providerService = yield* ProviderService;
  const engine = yield* OrchestrationEngineService;

  const reconcile = (forceAll: boolean) =>
    Effect.gen(function* () {
      const snapshot = yield* snapshots.getShellSnapshot();
      const active = snapshot.threads.filter(
        (thread) => isActiveShell(thread) || (forceAll && thread.session?.status === "ready"),
      );
      let reconciled = 0;
      let interrupted = 0;
      let stopped = 0;

      yield* Effect.forEach(active, (thread) =>
        Effect.gen(function* () {
          const binding = Option.getOrUndefined(yield* directory.getBinding(thread.id));
          if (!forceAll && !isOrphanedActiveSession(binding, directory.ownerGeneration)) return;

          const generation = binding?.sessionGeneration ?? undefined;
          const result = yield* providerService.runIfCurrentGeneration(
            {
              threadId: thread.id,
              ...(generation === undefined ? {} : { sessionGeneration: generation }),
            },
            Effect.gen(function* () {
              const session = thread.session;
              if (session === null) return;
              const status = session.activeTurnId === null ? "stopped" : "interrupted";
              const createdAt = DateTime.formatIso(yield* DateTime.now);
              yield* engine.dispatch({
                type: "thread.session.set",
                commandId: reconciliationCommandId(thread, binding?.sessionGeneration),
                threadId: thread.id,
                session: {
                  ...session,
                  status,
                  activeTurnId: null,
                  updatedAt: createdAt,
                },
                createdAt,
              });
              if (binding !== undefined) {
                yield* directory.upsert({
                  ...binding,
                  status: "stopped",
                  terminalDisposition: status === "interrupted" ? "interrupted" : null,
                  expectedSessionGeneration: binding.sessionGeneration ?? null,
                });
              }
              reconciled += 1;
              if (status === "interrupted") interrupted += 1;
              else stopped += 1;
            }),
          );
          if (Option.isNone(result)) {
            yield* Effect.logDebug("provider reconciliation skipped replaced session", {
              threadId: thread.id,
            });
          }
        }),
      );

      const verification = yield* snapshots.getShellSnapshot();
      const remainingOrphans = yield* Effect.filter(
        verification.threads.filter(isActiveShell),
        (thread) =>
          forceAll
            ? Effect.succeed(true)
            : directory
                .getBinding(thread.id)
                .pipe(
                  Effect.map((candidate) =>
                    isOrphanedActiveSession(
                      Option.getOrUndefined(candidate),
                      directory.ownerGeneration,
                    ),
                  ),
                ),
      );
      return {
        inspected: active.length,
        reconciled,
        interrupted,
        stopped,
        remainingOrphans: remainingOrphans.map((thread) => thread.id),
      };
    }).pipe(Effect.mapError((cause) => new SessionReconciliationError({ cause })));

  const reconcileOrphanedSessions: SessionReconcilerShape["reconcileOrphanedSessions"] =
    reconcile(false);
  const interruptActiveSessions: SessionReconcilerShape["interruptActiveSessions"] =
    reconcile(true);

  return { reconcileOrphanedSessions, interruptActiveSessions } satisfies SessionReconcilerShape;
});

export const SessionReconcilerLive = Layer.effect(SessionReconciler, makeSessionReconciler);
