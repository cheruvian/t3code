import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationShellSnapshot,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionGeneration,
  ServerOwnerGeneration,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../../orchestration/runtimeLayer.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { SessionReconciler, SessionReconciliationError } from "../Services/SessionReconciler.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import {
  isOrphanedActiveSession,
  isActiveShell,
  SessionReconcilerLive,
} from "./SessionReconciler.ts";

const owner = ServerOwnerGeneration.make("owner-current");
const baseBinding = {
  threadId: ThreadId.make("thread-1"),
  provider: ProviderDriverKind.make("codex"),
  status: "running" as const,
  ownerGeneration: owner,
  sessionGeneration: ProviderSessionGeneration.make("session-1"),
};

describe("SessionReconciler orphan classification", () => {
  it("treats missing, stopped, legacy, and prior-owner active bindings as orphaned", () => {
    expect(isOrphanedActiveSession(undefined, owner)).toBe(true);
    expect(isOrphanedActiveSession({ ...baseBinding, status: "stopped" }, owner)).toBe(true);
    expect(isOrphanedActiveSession({ ...baseBinding, ownerGeneration: null }, owner)).toBe(true);
    expect(
      isOrphanedActiveSession(
        { ...baseBinding, ownerGeneration: ServerOwnerGeneration.make("owner-old") },
        owner,
      ),
    ).toBe(true);
  });

  it("preserves a current-owner running binding", () => {
    expect(isOrphanedActiveSession(baseBinding, owner)).toBe(false);
  });

  it("never classifies ready shells as active, regardless of runtime status", () => {
    const ready = {
      session: { status: "ready" },
    } as unknown as Parameters<typeof isActiveShell>[0];
    expect(isActiveShell(ready)).toBe(false);
    expect(isOrphanedActiveSession({ ...baseBinding, status: "running" }, owner)).toBe(false);
    expect(isOrphanedActiveSession({ ...baseBinding, status: "stopped" }, owner)).toBe(true);
  });
});

effectIt.effect("reconciles prior-owner active work once through durable session commands", () => {
  const threadId = ThreadId.make("thread-reconcile-running");
  let session: OrchestrationSession = {
    threadId,
    status: "running" as const,
    providerName: "codex",
    runtimeMode: "full-access" as const,
    activeTurnId: TurnId.make("turn-1"),
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let binding: ProviderRuntimeBinding = {
    ...baseBinding,
    threadId,
    ownerGeneration: ServerOwnerGeneration.make("owner-prior"),
  };
  const commands: OrchestrationCommand[] = [];
  const snapshot = () =>
    ({
      threads: [
        {
          id: threadId,
          session,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        },
      ],
    }) as unknown as OrchestrationShellSnapshot;
  const dependencies = Layer.mergeAll(
    Layer.succeed(ProjectionSnapshotQuery, {
      getShellSnapshot: () => Effect.succeed(snapshot()),
    } as never),
    Layer.succeed(ProviderSessionDirectory, {
      ownerGeneration: owner,
      getBinding: () => Effect.succeed(Option.some(binding)),
      upsert: (next: ProviderRuntimeBinding) => Effect.sync(() => ((binding = next), true)),
    } as never),
    Layer.succeed(ProviderService, {
      runIfCurrentGeneration: (_input: unknown, effect: Effect.Effect<unknown>) =>
        Effect.map(effect, Option.some),
    } as never),
    Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.type === "thread.session.set") session = command.session as typeof session;
          return { sequence: commands.length };
        }),
    } as never),
  );
  return Effect.gen(function* () {
    const reconciler = yield* SessionReconciler;
    const first = yield* reconciler.reconcileOrphanedSessions;
    expect(first).toMatchObject({ reconciled: 1, interrupted: 1, stopped: 0 });
    expect(session.status).toBe("interrupted");
    expect(session.activeTurnId).toBeNull();
    expect(binding).toMatchObject({ status: "stopped", terminalDisposition: "interrupted" });

    const second = yield* reconciler.reconcileOrphanedSessions;
    expect(second.reconciled).toBe(0);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.commandId).toBe(
      CommandId.make(`provider-reconcile:${threadId}:session-1:interrupted`),
    );

    session = { ...session, status: "ready", activeTurnId: null };
    binding = { ...binding, status: "running", ownerGeneration: owner };
    const shutdown = yield* reconciler.interruptActiveSessions;
    expect(shutdown).toMatchObject({ reconciled: 1, interrupted: 0, stopped: 1 });
    expect(session.status).toBe("stopped");
  }).pipe(Effect.provide(SessionReconcilerLive.pipe(Layer.provide(dependencies))));
});

effectIt.effect("identifies the orphan whose reconciliation operation failed", () => {
  const threadId = ThreadId.make("thread-reconcile-failure");
  const failureCause = new Error("dispatch failed");
  const session: OrchestrationSession = {
    threadId,
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: TurnId.make("turn-reconcile-failure"),
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const binding: ProviderRuntimeBinding = {
    ...baseBinding,
    threadId,
    ownerGeneration: ServerOwnerGeneration.make("owner-prior"),
  };
  const dependencies = Layer.mergeAll(
    Layer.succeed(ProjectionSnapshotQuery, {
      getShellSnapshot: () =>
        Effect.succeed({
          threads: [
            {
              id: threadId,
              session,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
            },
          ],
        } as unknown as OrchestrationShellSnapshot),
    } as never),
    Layer.succeed(ProviderSessionDirectory, {
      ownerGeneration: owner,
      getBinding: () => Effect.succeed(Option.some(binding)),
      upsert: () => Effect.succeed(true),
    } as never),
    Layer.succeed(ProviderService, {
      runIfCurrentGeneration: (_input: unknown, effect: Effect.Effect<unknown>) =>
        Effect.map(effect, Option.some),
    } as never),
    Layer.succeed(OrchestrationEngineService, {
      dispatch: () => Effect.fail(failureCause),
    } as never),
  );

  return Effect.gen(function* () {
    const reconciler = yield* SessionReconciler;
    const failure = yield* Effect.flip(reconciler.reconcileOrphanedSessions);

    expect(failure).toBeInstanceOf(SessionReconciliationError);
    expect(failure).toMatchObject({
      phase: "provider-sessions.reconcile",
      operation: "reconcile-orphaned-sessions",
      failureKind: "operation-failed",
      affectedThreadIds: [threadId],
    });
    expect(failure.cause).toBe(failureCause);
  }).pipe(Effect.provide(SessionReconcilerLive.pipe(Layer.provide(dependencies))));
});

effectIt.effect("identifies the active thread whose convergence check failed", () => {
  const threadId = ThreadId.make("thread-reconcile-verification-failure");
  const failureCause = new Error("binding verification failed");
  const session: OrchestrationSession = {
    threadId,
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: TurnId.make("turn-reconcile-verification-failure"),
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const binding: ProviderRuntimeBinding = {
    ...baseBinding,
    threadId,
  };
  let bindingReads = 0;
  const dependencies = Layer.mergeAll(
    Layer.succeed(ProjectionSnapshotQuery, {
      getShellSnapshot: () =>
        Effect.succeed({
          threads: [
            {
              id: threadId,
              session,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
            },
          ],
        } as unknown as OrchestrationShellSnapshot),
    } as never),
    Layer.succeed(ProviderSessionDirectory, {
      ownerGeneration: owner,
      getBinding: () =>
        Effect.suspend(() => {
          bindingReads += 1;
          return bindingReads === 1
            ? Effect.succeed(Option.some(binding))
            : Effect.fail(failureCause);
        }),
    } as never),
    Layer.succeed(ProviderService, {
      runIfCurrentGeneration: (_input: unknown, effect: Effect.Effect<unknown>) =>
        Effect.map(effect, Option.some),
    } as never),
    Layer.succeed(OrchestrationEngineService, {
      dispatch: () => Effect.die("current-owner session must not be reconciled"),
    } as never),
  );

  return Effect.gen(function* () {
    const reconciler = yield* SessionReconciler;
    const failure = yield* Effect.flip(reconciler.reconcileOrphanedSessions);

    expect(bindingReads).toBe(2);
    expect(failure).toMatchObject({
      phase: "provider-sessions.reconcile",
      operation: "reconcile-orphaned-sessions",
      failureKind: "operation-failed",
      affectedThreadIds: [threadId],
    });
    expect(failure.cause).toBe(failureCause);
  }).pipe(Effect.provide(SessionReconcilerLive.pipe(Layer.provide(dependencies))));
});

effectIt.effect(
  "reconciles persisted orphan variants through events and rebuilds the same terminal lifecycle",
  () => {
    const projectId = ProjectId.make("project-startup-reconciliation");
    const priorOwnerActive = ThreadId.make("thread-prior-owner-active");
    const priorOwnerIdle = ThreadId.make("thread-prior-owner-idle");
    const missingActive = ThreadId.make("thread-missing-active");
    const stoppedActive = ThreadId.make("thread-stopped-active");
    const legacyActive = ThreadId.make("thread-legacy-active");
    const currentOwnerActive = ThreadId.make("thread-current-owner-active");
    const activeThreadIds = [
      priorOwnerActive,
      missingActive,
      stoppedActive,
      legacyActive,
      currentOwnerActive,
    ] as const;
    const allThreadIds = [...activeThreadIds, priorOwnerIdle] as const;
    const turnIdFor = (threadId: ThreadId) => TurnId.make(`turn-${threadId}`);
    const createdAt = "2026-08-13T12:00:00.000Z";

    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const directory = yield* ProviderSessionDirectory;
      const reconciler = yield* SessionReconciler;
      const sql = yield* SqlClient.SqlClient;

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-startup-reconciliation-project"),
        projectId,
        title: "Startup reconciliation",
        workspaceRoot: "/tmp/startup-reconciliation",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      yield* Effect.forEach(
        allThreadIds,
        (threadId) =>
          engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`cmd-create-${threadId}`),
            threadId,
            projectId,
            title: String(threadId),
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
          }),
        { concurrency: 1 },
      );

      yield* Effect.forEach(
        activeThreadIds,
        (threadId) =>
          Effect.gen(function* () {
            yield* engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make(`cmd-turn-start-${threadId}`),
              threadId,
              message: {
                messageId: MessageId.make(`message-${threadId}`),
                role: "user",
                text: "persisted work",
                attachments: [],
              },
              runtimeMode: "full-access",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              createdAt,
            });
            yield* engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make(`cmd-session-running-${threadId}`),
              threadId,
              session: {
                threadId,
                status: "running",
                providerName: "codex",
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeMode: "full-access",
                activeTurnId: turnIdFor(threadId),
                lastError: null,
                updatedAt: createdAt,
              },
              createdAt,
            });
          }),
        { concurrency: 1 },
      );
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`cmd-session-starting-${priorOwnerIdle}`),
        threadId: priorOwnerIdle,
        session: {
          threadId: priorOwnerIdle,
          status: "starting",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });

      const upsertBinding = (
        threadId: ThreadId,
        input: Pick<ProviderRuntimeBinding, "status" | "ownerGeneration" | "sessionGeneration">,
      ) =>
        directory.upsert({
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          ...input,
        });
      const priorOwner = ServerOwnerGeneration.make("owner-prior");
      yield* upsertBinding(priorOwnerActive, {
        status: "running",
        ownerGeneration: priorOwner,
        sessionGeneration: ProviderSessionGeneration.make("generation-prior-active"),
      });
      yield* upsertBinding(priorOwnerIdle, {
        status: "running",
        ownerGeneration: priorOwner,
        sessionGeneration: ProviderSessionGeneration.make("generation-prior-idle"),
      });
      yield* upsertBinding(stoppedActive, {
        status: "stopped",
        ownerGeneration: directory.ownerGeneration,
        sessionGeneration: ProviderSessionGeneration.make("generation-stopped"),
      });
      yield* upsertBinding(legacyActive, {
        status: "running",
        ownerGeneration: null,
        sessionGeneration: null,
      });
      yield* upsertBinding(currentOwnerActive, {
        status: "running",
        ownerGeneration: directory.ownerGeneration,
        sessionGeneration: ProviderSessionGeneration.make("generation-current"),
      });

      const beforeSequence = yield* engine.latestSequence;
      const first = yield* reconciler.reconcileOrphanedSessions;
      expect(first).toEqual({
        inspected: 6,
        reconciled: 5,
        interrupted: 4,
        stopped: 1,
        remainingOrphans: [],
      });

      const afterFirstSequence = yield* engine.latestSequence;
      expect(afterFirstSequence - beforeSequence).toBe(5);
      const second = yield* reconciler.reconcileOrphanedSessions;
      expect(second).toEqual({
        inspected: 1,
        reconciled: 0,
        interrupted: 0,
        stopped: 0,
        remainingOrphans: [],
      });
      expect(yield* engine.latestSequence).toBe(afterFirstSequence);

      const selectLifecycle = (snapshot: OrchestrationShellSnapshot) =>
        Object.fromEntries(
          snapshot.threads
            .filter((thread) => allThreadIds.includes(thread.id))
            .map((thread) => [
              thread.id,
              {
                session: thread.session,
                latestTurn: thread.latestTurn,
              },
            ]),
        );
      const live = selectLifecycle(yield* snapshots.getShellSnapshot());
      for (const threadId of [priorOwnerActive, missingActive, stoppedActive, legacyActive]) {
        expect(live[threadId]?.session).toMatchObject({
          status: "interrupted",
          activeTurnId: null,
        });
        expect(live[threadId]?.latestTurn).toMatchObject({
          turnId: turnIdFor(threadId),
          state: "interrupted",
        });
      }
      expect(live[priorOwnerIdle]?.session).toMatchObject({
        status: "stopped",
        activeTurnId: null,
      });
      expect(live[priorOwnerIdle]?.latestTurn).toBeNull();
      expect(live[currentOwnerActive]?.session).toMatchObject({
        status: "running",
        activeTurnId: turnIdFor(currentOwnerActive),
      });
      expect(live[currentOwnerActive]?.latestTurn).toMatchObject({
        turnId: turnIdFor(currentOwnerActive),
        state: "running",
      });
      for (const threadId of [priorOwnerActive, stoppedActive, legacyActive]) {
        expect(Option.getOrThrow(yield* directory.getBinding(threadId))).toMatchObject({
          status: "stopped",
          terminalDisposition: "interrupted",
        });
      }
      expect(Option.getOrThrow(yield* directory.getBinding(priorOwnerIdle))).toMatchObject({
        status: "stopped",
        terminalDisposition: null,
      });
      expect(Option.isNone(yield* directory.getBinding(missingActive))).toBe(true);
      expect(Option.getOrThrow(yield* directory.getBinding(currentOwnerActive))).toMatchObject({
        status: "running",
        ownerGeneration: directory.ownerGeneration,
        sessionGeneration: ProviderSessionGeneration.make("generation-current"),
      });

      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM projection_pending_approvals`;
          yield* sql`DELETE FROM projection_thread_activities`;
          yield* sql`DELETE FROM projection_thread_proposed_plans`;
          yield* sql`DELETE FROM projection_thread_messages`;
          yield* sql`DELETE FROM projection_thread_sessions`;
          yield* sql`DELETE FROM projection_turns`;
          yield* sql`DELETE FROM projection_threads`;
          yield* sql`DELETE FROM projection_projects`;
          yield* sql`DELETE FROM projection_state`;
        }),
      );
      yield* projectionPipeline.bootstrap;

      const replayed = selectLifecycle(yield* snapshots.getShellSnapshot());
      expect(replayed).toEqual(live);
    }).pipe(Effect.provide(persistedReconciliationTestLayer));
  },
);

const persistedSqliteLayer = SqlitePersistenceMemory;
const persistedServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-session-reconciler-persisted-test-",
});
const persistedOrchestrationLayer = OrchestrationLayerLive.pipe(
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(persistedSqliteLayer),
  Layer.provideMerge(persistedServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);
const persistedProviderRuntimeLayer = ProviderSessionRuntime.layer.pipe(
  Layer.provide(persistedSqliteLayer),
);
const persistedDirectoryLayer = ProviderSessionDirectoryLive.pipe(
  Layer.provide(persistedProviderRuntimeLayer),
);
const persistedReconciliationDependencies = Layer.mergeAll(
  persistedOrchestrationLayer,
  persistedDirectoryLayer,
  Layer.succeed(ProviderService, {
    runIfCurrentGeneration: (_input: unknown, effect: Effect.Effect<unknown>) =>
      Effect.map(effect, Option.some),
  } as never),
);
const persistedReconciliationTestLayer = SessionReconcilerLive.pipe(
  Layer.provideMerge(persistedReconciliationDependencies),
);
