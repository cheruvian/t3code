import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_MODEL,
  type OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as SessionReconciler from "./provider/Services/SessionReconciler.ts";

it("uses the canonical Codex default for auto-bootstrapped model selection", () => {
  assert.deepStrictEqual(ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("keeps activation work behind durable session reconciliation", () =>
  Effect.gen(function* () {
    const reconciliation = yield* Deferred.make<void>();
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const barrier = yield* ServerRuntimeStartup.completeSessionStartupBarrier({
      reconcile: Deferred.await(reconciliation).pipe(
        Effect.tap(() => Ref.update(calls, (current) => [...current, "reconcile"])),
        Effect.as({ remainingOrphans: [] }),
      ),
      completePersistedDrain: Ref.update(calls, (current) => [...current, "drain"]),
      startReaper: Ref.update(calls, (current) => [...current, "reaper"]),
    }).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    assert.deepStrictEqual(yield* Ref.get(calls), []);
    yield* Deferred.succeed(reconciliation, undefined);
    yield* Fiber.join(barrier);
    assert.deepStrictEqual(yield* Ref.get(calls), ["reconcile", "drain", "reaper"]);
  }),
);

it.effect("fails closed with structured startup evidence when reconciliation cannot converge", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const orphanedThreadId = ThreadId.make("thread-startup-orphan");
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const queuedCommandRuns = yield* Ref.make(0);
      const readyPublications = yield* Ref.make(0);
      const initialSnapshotReads = yield* Ref.make(0);
      const persistedDrainCompletions = yield* Ref.make(0);
      const reaperStarts = yield* Ref.make(0);

      const queuedCommand = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(queuedCommandRuns, (count) => count + 1))
        .pipe(Effect.forkScoped);

      const failure = yield* ServerRuntimeStartup.completeSessionStartupBarrier({
        reconcile: Effect.succeed({ remainingOrphans: [orphanedThreadId] }),
        completePersistedDrain: Ref.update(persistedDrainCompletions, (count) => count + 1),
        startReaper: Ref.update(reaperStarts, (count) => count + 1),
      }).pipe(
        Effect.tap(() => Ref.update(initialSnapshotReads, (count) => count + 1)),
        Effect.tap(() => Ref.update(readyPublications, (count) => count + 1)),
        Effect.tap(() => commandGate.signalCommandReady),
        Effect.flip,
      );

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: failure,
        }),
      );
      const queuedFailure = yield* Effect.flip(Fiber.join(queuedCommand));

      assert.equal(yield* Ref.get(queuedCommandRuns), 0);
      assert.equal(yield* Ref.get(readyPublications), 0);
      assert.equal(yield* Ref.get(initialSnapshotReads), 0);
      assert.equal(yield* Ref.get(persistedDrainCompletions), 0);
      assert.equal(yield* Ref.get(reaperStarts), 0);
      assert.equal(
        queuedFailure.message,
        "Server runtime startup failed before command readiness.",
      );

      const evidence = failure as unknown as {
        readonly phase?: string;
        readonly operation?: string;
        readonly failureKind?: string;
        readonly affectedThreadIds?: ReadonlyArray<ThreadId>;
        readonly cause?: unknown;
      };
      assert.equal(evidence.phase, "provider-sessions.reconcile");
      assert.equal(evidence.operation, "reconcile-orphaned-sessions");
      assert.equal(evidence.failureKind, "orphans-remain");
      assert.deepStrictEqual(evidence.affectedThreadIds, [orphanedThreadId]);
      assert.equal(
        typeof evidence.cause === "object" && evidence.cause !== null && "_tag" in evidence.cause,
        true,
      );
    }),
  ),
);

it("preserves reconciliation context on the outer startup error", () => {
  const affectedThreadId = ThreadId.make("thread-startup-error-context");
  const reconciliationCause = new SessionReconciler.SessionReconciliationDidNotConverge({
    affectedThreadIds: [affectedThreadId],
  });
  const reconciliationError = new SessionReconciler.SessionReconciliationError({
    phase: SessionReconciler.SESSION_RECONCILIATION_PHASE,
    operation: "reconcile-orphaned-sessions",
    failureKind: "orphans-remain",
    affectedThreadIds: [affectedThreadId],
    cause: reconciliationCause,
  });
  const startupCause = Cause.fail(reconciliationError);

  const startupError = ServerRuntimeStartup.makeServerRuntimeStartupError({
    mode: "web",
    host: "127.0.0.1",
    port: 3773,
    cause: startupCause,
  });

  assert.equal(startupError.phase, "provider-sessions.reconcile");
  assert.equal(startupError.operation, "reconcile-orphaned-sessions");
  assert.equal(startupError.failureKind, "orphans-remain");
  assert.deepStrictEqual(startupError.affectedThreadIds, [affectedThreadId]);
  assert.strictEqual(startupError.cause, startupCause);
  assert.strictEqual(Cause.squash(startupCause), reconciliationError);
});

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("launchStartupHeartbeat does not block the caller while counts are loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseCounts = yield* Deferred.make<void, never>();

      yield* ServerRuntimeStartup.launchStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () =>
            Deferred.await(releaseCounts).pipe(
              Effect.as({
                projectCount: 2,
                threadCount: 3,
              }),
            ),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
        Effect.provideService(AnalyticsService.AnalyticsService, {
          record: () => Effect.void,
          flush: Effect.void,
        }),
      );
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets returns existing project and thread ids", () => {
  const bootstrapProjectId = ProjectId.make("project-startup-bootstrap");
  const bootstrapThreadId = ThreadId.make("thread-startup-bootstrap");

  return Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            Option.some({
              id: bootstrapProjectId,
              title: "Startup Project",
              workspaceRoot: "/tmp/startup-project",
              defaultModelSelection: ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.some(bootstrapThreadId)),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.deepStrictEqual(targets, {
      bootstrapProjectId,
      bootstrapThreadId,
    });
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  });
});

it.effect("resolveAutoBootstrapWelcomeTargets creates a project and thread when missing", () =>
  Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.equal(typeof targets.bootstrapProjectId, "string");
    assert.equal(typeof targets.bootstrapThreadId, "string");
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), ["project.create", "thread.create"]);
  }),
);

it.effect("registers the T3 Code metaproject when it is missing", () =>
  Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    yield* ServerRuntimeStartup.ensureT3CodeMetaprojectRegistered("/tmp/t3-code-project").pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.die("unused"),
        getFullThreadDiffContext: () => Effect.die("unused"),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.die("unused"),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    const commands = yield* Ref.get(dispatchCalls);
    assert.equal(commands.length, 1);
    const command = commands[0];
    assert.equal(command?.type, "project.create");
    if (command?.type !== "project.create") return;
    assert.equal(command.title, "T3 Chat Helper");
    assert.equal(command.workspaceRoot, "/tmp/t3-code-project");
    assert.equal(command.defaultModelSelection, null);
  }),
);

it.effect("does not register a duplicate T3 Code metaproject", () =>
  Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    yield* ServerRuntimeStartup.ensureT3CodeMetaprojectRegistered("/tmp/t3-code-project").pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            Option.some({
              id: ProjectId.make("project-t3-code"),
              title: "T3 Code",
              workspaceRoot: "/tmp/t3-code-project",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.die("unused"),
        getFullThreadDiffContext: () => Effect.die("unused"),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.die("unused"),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets preserves typed UUID generation failures", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const uuidError = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "randomUUIDv4",
      description: "UUID generation unavailable",
    });
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);

    const error = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(Crypto.Crypto, {
        ...crypto,
        randomUUIDv4: Effect.fail(uuidError),
      }),
      Effect.flip,
    );

    assert.strictEqual(error, uuidError);
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
