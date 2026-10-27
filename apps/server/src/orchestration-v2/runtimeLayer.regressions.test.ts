import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  SourceControlProviderKind,
  type ApplicationStoredEvent,
  CheckpointId,
  CheckpointRef,
  CommandId,
  ContextTransferId,
  EventId,
  EnvironmentId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2Run,
  ProjectId,
  type PullRequestDetail,
  type PullRequestComment,
  PullRequestOperationError,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as EnvironmentHandlers from "../mcp/toolkits/environment/handlers.ts";
import { EnvironmentToolkit } from "../mcp/toolkits/environment/tools.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ROLLBACK_FAILED_MESSAGE } from "./CheckpointRollbackService.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import { shellStreamItemFromThreadShell } from "./ShellStream.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadMoveService from "./ThreadMoveService.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-runtime-layer-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const alternateInstanceId = ProviderInstanceId.make("codex_alternate");

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);
const layerGitWorkflowTest = Layer.mock(GitWorkflow.GitWorkflowService)({
  pruneWorktrees: () => Effect.void,
  createWorktree: () => Effect.succeed({} as never),
});
const layerProjectServiceTest = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeedNone,
  withActiveProject: (projectId) =>
    Effect.fail(new ProjectService.ProjectNotFoundError({ projectId })),
});

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by lifecycle tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;
const alternateProviderInstance = {
  ...providerInstance,
  instanceId: alternateInstanceId,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test:alternate",
  },
  displayName: "Codex alternate test",
  orchestrationAdapter: {
    ...orchestrationAdapter,
    instanceId: alternateInstanceId,
  },
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(
        [providerInstance, alternateProviderInstance].find(
          (instance) => instanceId === instance.instanceId,
        ),
      ),
    listInstances: Effect.succeed([providerInstance, alternateProviderInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const watchedPullRequestDetail = (input: {
  readonly projectId: ProjectId;
  readonly number: number;
  readonly at: string;
}): PullRequestDetail => ({
  provider: SourceControlProviderKind.make("github"),
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: false,
  },
  projectId: input.projectId,
  projectTitle: "Watch wake",
  workspaceRoot: "/workspace/watch",
  repository: "pingdotgg/t3code",
  number: input.number,
  title: "Watched pull request",
  body: "",
  url: `https://github.com/pingdotgg/t3code/pull/${input.number}`,
  author: { login: "agent-user", name: null, avatarUrl: null },
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  headSha: "abc1234def",
  baseBranch: "main",
  createdAt: input.at,
  updatedAt: input.at,
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "lint", status: "failure", description: null, url: null }],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  viewer: "agent-user",
});

const seedProject = (input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly createdAt: string;
}) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${input.projectId}`),
      aggregateKind: "project",
      aggregateId: input.projectId,
      occurredAt: input.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: input.projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        defaultModelSelection: input.defaultModelSelection,
        scripts: [],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    }),
  );

const moveProject = (projectId: ProjectId, workspaceRoot: string, updatedAt: string) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`move:${projectId}:${workspaceRoot}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: updatedAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.meta-updated",
      payload: { projectId, workspaceRoot, updatedAt },
    }),
  );

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

const layerLegacyImportTest = RuntimeLayer.layer.pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

const preferencesEnvironmentId = EnvironmentId.make("runtime-layer-preferences");
const layerEnvironmentMcpTest = McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
  Layer.provideMerge(layerTest),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: preferencesEnvironmentId,
        requestNamespace: "runtime-layer-preferences",
        thread: undefined,
        client: { sessionId: "preferences-client", label: "Test", access: "full-access" },
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: preferencesEnvironmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
    ),
  ),
);

it.layer(layerEnvironmentMcpTest)("environment MCP runtime wiring", (it) => {
  it.effect("updates and reads saved prompts using the orchestration runtime services", () =>
    Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const savedPrompts = [
        {
          id: "commit-changes",
          name: "Commit changes",
          text: "Commit changes.",
          behavior: "insert" as const,
        },
      ];
      const updated = yield* toolkit
        .handle("t3_environment_preferences_update", { savedPrompts })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(updated.at(-1)?.result).toMatchObject({ savedPrompts });
      const read = yield* toolkit
        .handle("t3_environment_read", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(read.at(-1)?.result).toMatchObject({ preferences: { savedPrompts } });
    }),
  );
});

const layerProjectDeletionTest = Layer.mergeAll(
  RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
  RuntimeLayer.layerProjectService,
  RuntimeLayer.layerEventSink,
).pipe(
  Layer.provide(
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerPlatformTest),
);

const layerSharedApplicationDataPlaneTest = Layer.mergeAll(
  RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
  RuntimeLayer.layerProjectService,
  RuntimeLayer.layerEventSink,
  RuntimeLayer.layerEventInfrastructure,
  EffectOutbox.layer,
).pipe(
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerPlatformTest),
);

const layerActiveTerminalThreadMoveTest = ThreadMoveService.layer.pipe(
  Layer.provideMerge(layerSharedApplicationDataPlaneTest),
  Layer.provide(
    Layer.mock(TerminalManager.TerminalManager)({
      hasOpenForThread: () => Effect.succeed(true),
    }),
  ),
);

it.layer(layerTest)("OrchestrationV2LayerLive", (it) => {
  it.effect("emits model updates separately from provider switches", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-model-selection-events");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-model-selection-events-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-model-selection-events-project"),
        title: "Model selection events",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      const sameInstance = yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("runtime-layer-model-selection-events-update"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-5.5" },
      });
      assert.deepEqual(
        sameInstance.storedEvents.map((stored) => stored.event.type),
        ["thread.model-selection-updated"],
      );

      const differentInstance = yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("runtime-layer-model-selection-events-switch"),
        threadId,
        modelSelection: { instanceId: alternateInstanceId, model: "gpt-5.5" },
      });
      assert.deepEqual(
        differentInstance.storedEvents.map((stored) => stored.event.type),
        ["thread.provider-switched"],
      );
    }),
  );

  const seedFailingRollbackThread = (name: string) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make(name);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${name}-create`),
        threadId,
        projectId: ProjectId.make(`${name}-project`),
        title: "Rollback failure",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: `/tmp/t3-${name}`,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${name}-message`),
        threadId,
        messageId: MessageId.make(`${name}-message`),
        text: "Create the provider thread and checkpoint scope.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const scope = (yield* orchestrator.getThreadProjection(threadId)).checkpointScopes[0]!;
      const now = yield* DateTime.now;
      const checkpointId = CheckpointId.make(`${name}-checkpoint`);
      yield* eventSink.write({
        commandId: CommandId.make(`${name}-seed`),
        events: [
          {
            id: EventId.make(`${name}-checkpoint-event`),
            type: "checkpoint.captured",
            threadId,
            occurredAt: now,
            payload: {
              id: checkpointId,
              threadId,
              scopeId: scope.id,
              runId: null,
              nodeId: scope.nodeId,
              parentCheckpointId: null,
              ordinalWithinScope: 0,
              appRunOrdinal: null,
              ref: CheckpointRef.make(`refs/t3/${name}`),
              status: "ready",
              files: [],
              capturedAt: now,
            },
          },
        ],
      });
      yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["provider-turn.start"],
        reason: "not under test",
      });
      return {
        threadId,
        rollback: (commandId: CommandId) =>
          orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId,
            threadId,
            checkpointId,
            scopeId: scope.id,
            restoreFiles: false,
          }),
      };
    });

  it.effect("ignores a late failure from a rollback that a newer one superseded", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const { threadId, rollback } = yield* seedFailingRollbackThread(
        "runtime-rollback-superseded",
      );

      const olderCommandId = CommandId.make("runtime-rollback-superseded-older");
      yield* rollback(olderCommandId);
      for (let attempt = 0; attempt < 4; attempt++) {
        yield* worker.drain();
        yield* TestClock.adjust("30 seconds");
      }
      const newerCommandId = CommandId.make("runtime-rollback-superseded-newer");
      yield* rollback(newerCommandId);
      yield* worker.drain();

      const [olderEffect] = yield* outbox.listByCommandId(olderCommandId);
      assert.equal(olderEffect?.status, "failed");
      const superseded = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(superseded.thread.rollbackFailure);

      for (let attempt = 0; attempt < 5; attempt++) {
        yield* TestClock.adjust("30 seconds");
        yield* worker.drain();
      }
      const [newerEffect] = yield* outbox.listByCommandId(newerCommandId);
      assert.equal(newerEffect?.status, "failed");
      const failed = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(failed.thread.rollbackFailure, {
        requestId: newerCommandId,
        message: ROLLBACK_FAILED_MESSAGE,
      });
    }),
  );

  it.effect("resolves delivery intent against the active run and starts after it completes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const threadId = ThreadId.make("runtime-delivery-intent");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-delivery-intent-create"),
        threadId,
        projectId: ProjectId.make("runtime-delivery-intent-project"),
        title: "Delivery intent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-delivery-intent-first"),
        threadId,
        messageId: MessageId.make("runtime-delivery-intent-first"),
        text: "Start work.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const initial = yield* orchestrator.getThreadProjection(threadId);
      const run = initial.runs[0]!;
      const providerThread = initial.providerThreads[0]!;
      const now = yield* DateTime.now;
      const providerSession = {
        id: providerThread.providerSessionId!,
        driver,
        providerInstanceId: modelSelection.instanceId,
        status: "running" as const,
        cwd: process.cwd(),
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const providerTurn = {
        id: ProviderTurnId.make("runtime-delivery-intent-turn"),
        providerThreadId: providerThread.id,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running" as const,
        startedAt: now,
        completedAt: null,
      };
      yield* eventSink.write({
        commandId: CommandId.make("runtime-delivery-intent-running"),
        events: [
          {
            id: EventId.make("runtime-delivery-intent-run-event"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "running", startedAt: now },
          },
          {
            id: EventId.make("runtime-delivery-intent-session-event"),
            type: "provider-session.attached",
            threadId,
            occurredAt: now,
            payload: providerSession,
          },
          {
            id: EventId.make("runtime-delivery-intent-turn-event"),
            type: "provider-turn.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: providerTurn,
          },
        ],
      });
      const sessionSpy = vi
        .spyOn(sessions, "get")
        .mockReturnValue(
          Effect.succeedSome({
            providerSession,
          } as ProviderAdapter.ProviderAdapterV2SessionRuntime),
        );
      yield* Effect.addFinalizer(() => Effect.sync(() => sessionSpy.mockRestore()));

      const steerCommandId = CommandId.make("runtime-delivery-intent-auto");
      const steerMessageId = MessageId.make("runtime-delivery-intent-auto");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: steerCommandId,
        threadId,
        messageId: steerMessageId,
        text: "Include this in the active work.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        deliveryIntent: "auto",
      });
      const steered = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(steered.runs, 1);
      assert.equal(
        steered.messages.find((message) => message.id === steerMessageId)?.runId,
        run.id,
      );
      assert.deepEqual(
        (yield* outbox.listByCommandId(steerCommandId)).map((effect) => effect.request),
        [
          {
            type: "provider-turn.steer",
            providerSessionId: providerSession.id,
            providerThreadId: providerThread.id,
            providerTurnId: providerTurn.id,
            messageId: steerMessageId,
          },
        ],
      );

      yield* eventSink.write({
        commandId: CommandId.make("runtime-delivery-intent-completed"),
        events: [
          {
            id: EventId.make("runtime-delivery-intent-run-completed"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", startedAt: now, completedAt: now },
          },
          {
            id: EventId.make("runtime-delivery-intent-turn-completed"),
            type: "provider-turn.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...providerTurn, status: "completed", completedAt: now },
          },
        ],
      });
      const nextCommandId = CommandId.make("runtime-delivery-intent-next");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: nextCommandId,
        threadId,
        messageId: MessageId.make("runtime-delivery-intent-next"),
        text: "The previous run finished before this arrived.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        deliveryIntent: "restart",
      });
      const restarted = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        restarted.runs.map((candidate) => candidate.status),
        ["completed", "starting"],
      );
      assert.deepEqual(
        (yield* outbox.listByCommandId(nextCommandId)).map((effect) => effect.request.type),
        ["provider-turn.start"],
      );
    }),
  );

  it.effect.each(["message", "failed-native"] as const)(
    "answers a %s question after its provider exits and commits the answer once",
    (initialMode) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`runtime-async-question:${initialMode}`);
        const requestId = RuntimeRequestId.make(`runtime-async-question-request:${initialMode}`);
        const nodeId = NodeId.make(`runtime-async-question-node:${initialMode}`);
        const itemId = TurnItemId.make(`runtime-async-question-item:${initialMode}`);
        const providerTurnId = ProviderTurnId.make(`runtime-async-question-turn:${initialMode}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`runtime-async-question-create:${initialMode}`),
          createdBy: "user",
          creationSource: "web",
          threadId,
          projectId: ProjectId.make(`runtime-async-question-project:${initialMode}`),
          title: "Async question",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* eventSink.write({
          commandId: CommandId.make(`runtime-async-question-seed:${initialMode}`),
          events: [
            {
              id: EventId.make(`runtime-async-question-node-event:${initialMode}`),
              type: "node.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: nodeId,
                threadId,
                runId: null,
                parentNodeId: null,
                rootNodeId: nodeId,
                kind: "user_input_request",
                status: "waiting",
                countsForRun: false,
                providerThreadId: null,
                providerTurnId,
                nativeItemRef: null,
                runtimeRequestId: requestId,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            },
            {
              id: EventId.make(`runtime-async-question-request-event:${initialMode}`),
              type: "runtime-request.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: requestId,
                nodeId,
                providerTurnId,
                nativeRequestRef: null,
                kind: "user_input",
                status: "pending",
                responseCapability:
                  initialMode === "message"
                    ? { type: "message" }
                    : {
                        type: "live",
                        providerSessionId: ProviderSessionId.make("question-session"),
                      },
                createdAt: now,
                resolvedAt: null,
              },
            },
            {
              id: EventId.make(`runtime-async-question-item-event:${initialMode}`),
              type: "turn-item.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: itemId,
                type: "user_input_request",
                threadId,
                runId: null,
                nodeId,
                providerThreadId: null,
                providerTurnId,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "waiting",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                requestId,
                ...(initialMode === "message" ? { responseMode: "message" as const } : {}),
                questions: [
                  { id: "color", header: "Color", question: "Which color?", options: [] },
                ],
              },
            },
          ],
        });
        if (initialMode === "failed-native") {
          const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2.pipe(
            Effect.provide(
              ProviderEventIngestor.layer.pipe(
                Layer.provide(IdAllocator.layer),
                Layer.provide(
                  GitVcsDriver.layer.pipe(
                    Layer.provide(layerServerConfig),
                    Layer.provide(NodeServices.layer),
                  ),
                ),
              ),
            ),
          );
          yield* ingestor.ingestNormalized({
            providerSessionId: ProviderSessionId.make("question-session"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            threadId,
            event: {
              type: "turn.terminal",
              driver: ProviderDriverKind.make("codex"),
              providerThreadId: ProviderThreadId.make("question-thread"),
              providerTurnId,
              runOrdinal: 1,
              status: "failed",
              failureItemOrdinal: 10,
              failure: {
                class: "provider_error",
                message: "Provider exited",
                code: null,
                retryable: null,
              },
              threadDisposition: "reusable",
            },
          });
          const reopened = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(reopened.runtimeRequests[0]?.responseCapability, { type: "message" });
          assert.equal(reopened.runtimeRequests[0]?.status, "pending");
        }
        const invalid = yield* orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make(`runtime-async-question-blank:${initialMode}`),
            threadId,
            requestId,
            answers: { color: " " },
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");
        const unanswered = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(unanswered.runtimeRequests[0]?.status, "pending");
        assert.deepEqual(unanswered.messages, []);

        const command = {
          type: "runtime-request.respond" as const,
          commandId: CommandId.make(`runtime-async-question-answer:${initialMode}`),
          threadId,
          requestId,
          answers: { color: "  Blue  " },
        };
        const accepted = yield* orchestrator.dispatch(command);
        const repeated = yield* orchestrator.dispatch(command);
        assert.equal(repeated.sequence, accepted.sequence);
        const answered = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(answered.runtimeRequests[0]?.status, "resolved");
        assert.deepEqual(answered.runtimeRequests[0]?.answers, command.answers);
        assert.equal(answered.nodes.find((node) => node.id === nodeId)?.status, "completed");
        assert.equal(answered.turnItems.find((item) => item.id === itemId)?.status, "completed");
        const answeredItem = answered.turnItems.find((item) => item.id === itemId);
        assert.equal(answeredItem?.type, "user_input_request");
        if (answeredItem?.type === "user_input_request") {
          assert.deepEqual(answeredItem.questionAnswer, {
            requestId,
            answers: command.answers,
            attachmentsByQuestionId: {},
            questionTextById: { color: "Which color?" },
          });
        }
        assert.equal(answered.messages.length, 1);
        assert.equal(answered.messages[0]?.text, "Which color?\nBlue");
        assert.equal(answered.messages[0]?.role, "user");
        assert.equal(answered.runs.length, 1);

        const duplicate = yield* orchestrator
          .dispatch({
            ...command,
            commandId: CommandId.make(`runtime-async-question-duplicate:${initialMode}`),
          })
          .pipe(Effect.result);
        assert.equal(duplicate._tag, "Failure");
        assert.equal((yield* orchestrator.getThreadProjection(threadId)).messages.length, 1);
      }),
  );
});

it.layer(layerTest)("OrchestrationV2LayerLive lifecycle", (it) => {
  it.effect("persists linked pull requests through projection rebuilds and unlinking", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const threadId = ThreadId.make("runtime-layer-linked-pull-request-thread");
      const linkedPullRequest = {
        projectId: ProjectId.make("runtime-layer-linked-pull-request-project"),
        repository: "pingdotgg/t3code",
        number: 8160,
        url: "https://github.com/pingdotgg/t3code/pull/8160",
      } as const;

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-linked-pull-request-create"),
        threadId,
        projectId: linkedPullRequest.projectId,
        title: "Linked pull request thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-linked-pull-request-link"),
        threadId,
        linkedPullRequest,
      });

      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).thread.linkedPullRequest,
        linkedPullRequest,
      );
      const linkedShell = yield* orchestrator.getThreadShell(threadId);
      assert.isNotNull(linkedShell);
      assert.deepEqual(linkedShell.linkedPullRequest, linkedPullRequest);

      const rebuilt = yield* maintenance.rebuild;
      assert.isTrue(rebuilt.valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).thread.linkedPullRequest,
        linkedPullRequest,
      );

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-linked-pull-request-unlink"),
        threadId,
        linkedPullRequest: null,
      });
      assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.linkedPullRequest);
      const unlinkedShell = yield* orchestrator.getThreadShell(threadId);
      assert.isNotNull(unlinkedShell);
      assert.isNull(unlinkedShell.linkedPullRequest);
    }),
  );

  it.effect("keeps the branch pull request when linking another pull request", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const threadId = ThreadId.make("branch-pr-link");
      const projectId = ProjectId.make("branch-pr-project");
      yield* seedProject({
        projectId,
        title: "PR links",
        workspaceRoot: "/workspace/pr-links",
        defaultModelSelection: null,
        createdAt: "2026-09-17T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("branch-pr-create"),
        threadId,
        projectId,
        title: "PR links",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature/pr-links",
        worktreePath: null,
      });
      const snapshot = yield* orchestrator.getShellSnapshot();
      yield* orchestrator.dispatch({
        type: "thread.pull-request.sync",
        commandId: CommandId.make("branch-pr-discover"),
        threadId,
        projectId,
        snapshotSequence: snapshot.snapshotSequence,
        expected: {
          workspaceRoot: "/workspace/pr-links",
          branch: "feature/pr-links",
          worktreePath: null,
          linkedPullRequest: null,
          branchPullRequest: null,
        },
        branchPullRequest: {
          projectId,
          repository: "pingdotgg/t3code",
          number: 1,
          url: "https://github.com/pingdotgg/t3code/pull/1",
        },
      });
      for (const [index, number] of [2, 2, 1, 3].entries()) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`branch-pr-link-${index}`),
          threadId,
          host: "GitHub.com",
          repository: "Pingdotgg/T3code",
          number,
          url: `https://github.com/pingdotgg/t3code/pull/${number}`,
          source: "manual",
        });
        assert.deepEqual(
          (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.map((link) => link.number),
          number === 3 ? [1, 2, 3] : [1, 2],
        );
      }
      yield* orchestrator.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make("branch-pr-unlink"),
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 1,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("branch-pr-link-after-unlink"),
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 4,
        url: "https://github.com/pingdotgg/t3code/pull/4",
        source: "manual",
      });
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.map((link) => link.number),
        [2, 3, 4],
      );
    }),
  );

  it.effect.each(["manual", "automatic"])("settling ends every pull request watch: %s", (mode) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const threadId = ThreadId.make(`pr-watch-settle-${mode}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`pr-watch-settle-create-${mode}`),
        threadId,
        projectId: ProjectId.make("pr-watch-settle-project"),
        title: "Settle watched PRs",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code" };
      for (const number of [7, 8]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-settle-start-${mode}-${number}`),
          threadId,
          ...key,
          number,
          watching: true,
          link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
        });
      }
      const before = yield* orchestrator.getThreadShell(threadId);
      const started = before?.pullRequests?.[0]?.watch;
      assert.isDefined(started);
      if (started === undefined || before === null) return;
      yield* orchestrator.dispatch({
        ...(mode === "manual"
          ? { type: "thread.settle" as const }
          : { type: "thread.auto-settle" as const, snapshotAt: before.updatedAt }),
        commandId: CommandId.make(`pr-watch-settle-${mode}`),
        threadId,
      });
      const expected = before.pullRequests?.map(({ watch, ...link }) => ({
        ...link,
        ...(watch === undefined ? {} : { endedWatch: watch }),
      }));
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.pullRequests, expected);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.pullRequests, expected);

      for (const wake of [
        undefined,
        {
          messageId: MessageId.make(`pr-watch-settle-late-wake-${mode}`),
          text: "Update",
          notification: {
            source: { kind: "monitor" as const },
            outcome: "updated" as const,
            summary: "#7",
          },
        },
      ]) {
        const late = yield* orchestrator
          .dispatch({
            type: "thread.pull-request-watch.sync",
            commandId: CommandId.make(`pr-watch-settle-late-${mode}-${wake !== undefined}`),
            threadId,
            ...key,
            number: 7,
            startedAt: started.startedAt,
            watch: { ...started, headSha: "late", wakes: 1 },
            ...(wake === undefined ? {} : { wake }),
          })
          .pipe(Effect.flip);
        assert.equal(late._tag, "OrchestratorDispatchError");
      }
      const restart = {
        type: "thread.pull-request.watch" as const,
        threadId,
        ...key,
        number: 7,
        watching: true,
      };
      const blocked = yield* orchestrator
        .dispatch({
          ...restart,
          commandId: CommandId.make(`pr-watch-settle-blocked-${mode}`),
        })
        .pipe(Effect.flip);
      assert.equal(blocked._tag, "OrchestratorDispatchError");
      assert.deepEqual((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages, []);
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make(`pr-watch-settle-unsettle-${mode}`),
        threadId,
        reason: "user",
      });
      yield* orchestrator.dispatch({
        ...restart,
        commandId: CommandId.make(`pr-watch-settle-restart-${mode}`),
      });
      assert.isDefined((yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch);
    }),
  );

  it.effect(
    "reads a watched pull request once a pass, waits out rate limits, and skips quiet passes",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projectId = ProjectId.make("pr-watch-shared-project");
        yield* seedProject({
          projectId,
          title: "Watch shared",
          workspaceRoot: "/workspace/watch-shared",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        const threadIds = ["one", "two"].map((name) =>
          ThreadId.make(`runtime-pull-request-watch-shared-${name}`),
        );
        const watchFrom = (threadId: ThreadId) =>
          Effect.gen(function* () {
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`create:${threadId}`),
              threadId,
              projectId,
              title: "Watch shared",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            yield* orchestrator.dispatch({
              type: "thread.pull-request.watch",
              commandId: CommandId.make(`watch:${threadId}`),
              threadId,
              host: "github.com",
              repository: "pingdotgg/t3code",
              number: 9,
              watching: true,
              link: { url: "https://github.com/pingdotgg/t3code/pull/9", source: "agent" },
            });
          });
        for (const threadId of threadIds) yield* watchFrom(threadId);
        const rateLimited = new PullRequestOperationError({
          operation: "getChangeRequest",
          detail: "github requests are paused until the rate limit resets",
          cause: new PullRequestProviderError({
            provider: SourceControlProviderKind.make("github"),
            operation: "getChangeRequest",
            reason: "rate-limited",
            detail: "paused",
          }),
        });
        let host: "rate-limited" | "open" | "closed" = "rate-limited";
        let reads = 0;
        const reactor = yield* PullRequestWatchReactor.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.mock(PullRequestService.PullRequestService)({
                detail: () =>
                  Effect.suspend(() => {
                    reads += 1;
                    return host === "rate-limited"
                      ? Effect.fail(rateLimited)
                      : Effect.succeed({
                          ...watchedPullRequestDetail({
                            projectId,
                            number: 9,
                            at: "2026-10-02T12:00:00.000Z",
                          }),
                          state: host,
                          checks: [
                            { name: "lint", status: "success", description: null, url: null },
                          ],
                        });
                  }),
                activity: () =>
                  host === "rate-limited"
                    ? Effect.fail(rateLimited)
                    : Effect.succeed({
                        comments: [],
                        commentCount: 0,
                        commentsTruncated: false,
                        reviewThreads: [],
                        commits: [],
                      }),
              }),
            ),
          ),
        );
        const summaries = (threadId: ThreadId) =>
          Effect.map(orchestrator.getThreadRecords(threadId, ["messages"]), ({ messages }) =>
            messages.flatMap((message) => message.notification?.summary ?? []),
          );
        const watching = (threadId: ThreadId) =>
          Effect.map(
            orchestrator.getThreadShell(threadId),
            (thread) => thread?.pullRequests?.[0]?.watch !== undefined,
          );

        for (let pass = 0; pass < 20; pass += 1) yield* reactor.sweep;
        assert.equal(reads, 20);
        for (const threadId of threadIds) {
          assert.isTrue(yield* watching(threadId));
          assert.deepEqual(yield* summaries(threadId), []);
        }

        host = "open";
        yield* reactor.sweep;
        assert.equal(reads, 21);
        for (const threadId of threadIds) {
          assert.deepEqual(yield* summaries(threadId), ["#9: checks passed"]);
        }

        yield* reactor.sweep;
        assert.equal(reads, 21);

        const late = ThreadId.make("runtime-pull-request-watch-shared-late");
        yield* watchFrom(late);
        yield* reactor.sweep;
        assert.equal(reads, 22);
        assert.deepEqual(yield* summaries(late), ["#9: checks passed"]);
        for (const threadId of threadIds) {
          assert.deepEqual(yield* summaries(threadId), ["#9: checks passed"]);
        }
        threadIds.push(late);

        host = "closed";
        yield* TestClock.adjust("10 minutes");
        yield* reactor.sweep;
        assert.equal(reads, 23);
        for (const threadId of threadIds) {
          assert.isFalse(yield* watching(threadId));
          assert.deepEqual(yield* summaries(threadId), [
            "#9: checks passed",
            "#9: closed, stopped watching",
          ]);
        }
      }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );

  it.effect("reports how long an ended watch was quiet", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-ended");
      const projectId = ProjectId.make("pr-watch-ended-project");
      yield* seedProject({
        projectId,
        title: "Watch ended",
        workspaceRoot: "/workspace/watch-ended",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-ended-create"),
        threadId,
        projectId,
        title: "Watch ended",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 11 };
      const watching = (on: boolean, id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-ended-${id}`),
          threadId,
          ...key,
          watching: on,
          link: { url: "https://github.com/pingdotgg/t3code/pull/11", source: "agent" },
        });
      yield* watching(true, "start");

      let headSha = "aaaaaaa";
      const ended: Array<unknown> = [];
      const capture = Logger.make(({ message }) => {
        const [text, fields] = Array.isArray(message) ? message : [message];
        if (text === "pull request watch ended") ended.push(fields);
      });
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(PullRequestService.PullRequestService)({
              detail: () =>
                Effect.sync(() => ({
                  ...watchedPullRequestDetail({ projectId, number: key.number, at: "2026-10-02" }),
                  headSha,
                  checks: [],
                })),
              activity: () =>
                Effect.succeed({
                  comments: [],
                  commentCount: 0,
                  commentsTruncated: false,
                  reviewThreads: [],
                  commits: [],
                }),
            }),
          ),
        ),
      );
      const sweep = reactor.sweep.pipe(Effect.provide(Logger.layer([capture])));

      yield* sweep;
      yield* TestClock.adjust("6 hours");
      headSha = "bbbbbbb";
      yield* sweep;
      yield* TestClock.adjust("2 hours");
      yield* sweep;
      yield* watching(false, "stop");
      yield* sweep;
      yield* sweep;

      assert.deepEqual(ended, [
        {
          threadId,
          pullRequest: "github.com/pingdotgg/t3code#11",
          reason: "stopped",
          minutes: 480,
          quietMinutes: 120,
          longestQuietMinutes: 360,
          wakes: 0,
          reads: 3,
          partial: false,
        },
      ]);
    }),
  );

  it.effect("with a host fingerprint, a watch reads only what moved", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("pr-watch-fingerprint-project");
      const threadId = ThreadId.make("runtime-pull-request-watch-fingerprint");
      yield* seedProject({
        projectId,
        title: "Watch fingerprint",
        workspaceRoot: "/workspace/watch-fingerprint",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-fingerprint-create"),
        threadId,
        projectId,
        title: "Watch fingerprint",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-fingerprint-start"),
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 11,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/11", source: "agent" },
      });

      let fingerprint: { status: string; remarks: string } | "rate-limited" = {
        status: "OPEN pending",
        remarks: "0",
      };
      type CheckStatus = "pending" | "success" | "failure";
      let checks: { lint: CheckStatus; test: CheckStatus } = { lint: "pending", test: "pending" };
      let cachedChecks: typeof checks | null = null;
      let comments: Array<PullRequestComment> = [];
      let detailReads = 0;
      let activityReads = 0;
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(PullRequestService.PullRequestService)({
              watchFingerprint: () =>
                Effect.suspend(() =>
                  fingerprint === "rate-limited"
                    ? Effect.fail(
                        new PullRequestOperationError({
                          operation: "watchFingerprint",
                          detail: "paused",
                          cause: new PullRequestProviderError({
                            provider: SourceControlProviderKind.make("github"),
                            operation: "getChangeRequestWatchFingerprint",
                            reason: "rate-limited",
                            detail: "paused",
                          }),
                        }),
                      )
                    : Effect.succeed(fingerprint),
                ),
              invalidate: () =>
                Effect.sync(() => {
                  cachedChecks = null;
                }),
              detail: () =>
                Effect.sync(() => {
                  detailReads += 1;
                  const answer = cachedChecks ?? checks;
                  cachedChecks = null;
                  return {
                    ...watchedPullRequestDetail({
                      projectId,
                      number: 11,
                      at: "2026-10-02T12:00:00.000Z",
                    }),
                    checks: Object.entries(answer).map(([name, status]) => ({
                      name,
                      status,
                      description: null,
                      url: null,
                    })),
                  };
                }),
              activity: () =>
                Effect.sync(() => {
                  activityReads += 1;
                  return {
                    comments,
                    commentCount: comments.length,
                    commentsTruncated: false,
                    reviewThreads: [],
                    commits: [],
                  };
                }),
            }),
          ),
        ),
      );
      const reads = () => ({ detail: detailReads, activity: activityReads });
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );

      yield* reactor.sweep;
      assert.deepEqual(reads(), { detail: 1, activity: 1 });

      checks = { lint: "failure", test: "pending" };
      yield* reactor.sweep;
      assert.deepEqual(reads(), { detail: 2, activity: 1 });
      assert.deepEqual(yield* summaries, ["#11: checks failed"]);

      yield* TestClock.adjust("1 millis");
      cachedChecks = checks;
      checks = { lint: "failure", test: "success" };
      fingerprint = { status: "OPEN settled", remarks: "0" };
      yield* reactor.sweep;
      assert.deepEqual(reads(), { detail: 3, activity: 1 });

      for (let pass = 0; pass < 5; pass += 1) yield* reactor.sweep;
      assert.deepEqual(reads(), { detail: 3, activity: 1 });

      yield* TestClock.adjust("1 millis");
      comments = [
        {
          id: "comment-1",
          kind: "issue-comment",
          author: { login: "reviewer", name: null, avatarUrl: null },
          body: "Please rename this.",
          createdAt: "2999-01-01T00:00:00.000Z",
          url: null,
          path: null,
          reviewState: null,
        },
      ];
      fingerprint = { status: "OPEN settled", remarks: "1" };
      yield* reactor.sweep;
      assert.deepEqual(reads(), { detail: 4, activity: 2 });
      assert.deepEqual(yield* summaries, ["#11: checks failed", "#11: new comments"]);

      fingerprint = "rate-limited";
      yield* reactor.sweep;
      assert.deepEqual(reads(), { detail: 4, activity: 2 });
      assert.isDefined((yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch);

      fingerprint = { status: "OPEN settled", remarks: "1" };
      yield* TestClock.adjust("30 minutes");
      yield* reactor.sweep;
      assert.deepEqual(reads(), { detail: 5, activity: 3 });
      assert.deepEqual(yield* summaries, ["#11: checks failed", "#11: new comments"]);
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );

  it.effect(
    "admits restart continuations once and rejects a stale continuation behind newer work",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("runtime-layer-restart-continuation");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("restart-create"),
          threadId,
          projectId: ProjectId.make("restart-project"),
          title: "Restart",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/runtime-layer-restart",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("restart-user-message"),
          threadId,
          messageId: MessageId.make("restart-user-message"),
          text: "Original work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const original = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const now = yield* DateTime.now;
        yield* eventSink.commitCommand({
          commandId: CommandId.make("restart-cancel"),
          threadId,
          commandType: "provider-runtime.reconcile",
          acceptedAt: now,
          events: [
            {
              id: EventId.make("restart-cancel-event"),
              type: "run.updated",
              threadId,
              runId: original.id,
              occurredAt: now,
              payload: { ...original, status: "cancelled", completedAt: now },
            },
          ],
          effects: [],
        });
        const command = {
          type: "message.dispatch" as const,
          createdBy: "agent" as const,
          creationSource: "server" as const,
          commandId: CommandId.make("restart-automatic-message"),
          threadId,
          messageId: MessageId.make("restart-automatic-message"),
          text: "Continue where you left off.",
          notification: {
            source: { kind: "system" as const },
            outcome: "updated" as const,
            summary: "T3 Code restarted and resumed this turn",
            detail: "Continue where you left off.",
          },
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" as const },
          restartContinuationOfRunId: original.id,
        };
        yield* orchestrator.dispatch(command);
        yield* orchestrator.dispatch(command);
        const admitted = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(admitted.runs, 2);
        assert.equal(admitted.runs[1]?.restartContinuationOfRunId, original.id);
        const continuationItems = admitted.turnItems.filter(
          (item) => item.runId === admitted.runs[1]?.id,
        );
        assert.isFalse(continuationItems.some((item) => item.type === "user_message"));
        assert.deepInclude(
          continuationItems.flatMap((item) =>
            item.type === "notification" ? [[item.summary, item.detail]] : [],
          ),
          ["T3 Code restarted and resumed this turn", "Continue where you left off."],
        );
        yield* orchestrator.dispatch({
          ...command,
          commandId: CommandId.make("restart-stale-race"),
          messageId: MessageId.make("restart-stale-race"),
        });
        const raced = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(raced.runs, 2);
        assert.isFalse(raced.messages.some((message) => message.id === "restart-stale-race"));
      }),
  );

  it.effect.each([
    ["failed", "shell", false],
    ["completed", "shell", false],
    ["waiting", "shell", false],
    ["cancelled", "shell", false],
    ["failed", "monitor", false],
    ["completed", "monitor", true],
    ["waiting", "monitor", true],
    ["cancelled", "monitor", true],
  ] as const)(
    "admits a restart continuation of a %s run that lost a %s: %s",
    ([status, kind, admitted]) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`runtime-layer-restart-${status}-${kind}-source`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`restart-${status}-${kind}-create`),
          threadId,
          projectId: ProjectId.make("restart-project"),
          title: "Restart",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/runtime-layer-restart-failed",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`restart-${status}-${kind}-user-message`),
          threadId,
          messageId: MessageId.make(`restart-${status}-${kind}-user-message`),
          text: "Original work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const original = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const now = yield* DateTime.now;
        yield* eventSink.commitCommand({
          commandId: CommandId.make(`restart-${status}-${kind}-reconcile`),
          threadId,
          commandType: "provider-runtime.reconcile",
          acceptedAt: now,
          events: [
            {
              id: EventId.make(`restart-${status}-${kind}-run`),
              type: "run.updated",
              threadId,
              runId: original.id,
              occurredAt: now,
              payload: { ...original, status, completedAt: now },
            },
            {
              id: EventId.make(`restart-${status}-${kind}-work`),
              type: "run.background-work-cancelled",
              threadId,
              runId: original.id,
              occurredAt: now,
              payload: {
                runId: original.id,
                restartCancelledBackgroundWork: [{ kind, label: "sleep 25" }],
              },
            },
          ],
          effects: [],
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make(`restart-${status}-${kind}-continuation`),
          threadId,
          messageId: MessageId.make(`restart-${status}-${kind}-continuation`),
          text: "Note: the T3 server restarted.",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          restartContinuationOfRunId: original.id,
        });
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, status);
        assert.deepEqual(
          projection.runs.slice(1).map((run) => run.restartContinuationOfRunId),
          admitted ? [original.id] : [],
        );
      }),
  );

  it.effect("cancels queued work when a thread is archived", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-archive-queued-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-archive-queued-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-archive-queued-project"),
        title: "Archive queued work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-archive-queued",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-archive-queued-active-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-archive-queued-active-message"),
        text: "Keep the provider occupied.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-archive-queued-next-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-archive-queued-next-message"),
        text: "Do not run this after archive.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });

      const beforeArchive = yield* orchestrator.getThreadProjection(threadId);
      const activeRun = beforeArchive.runs.find((run) => run.status === "starting");
      const queuedRun = beforeArchive.runs.find((run) => run.status === "queued");
      assert.isDefined(activeRun);
      assert.isDefined(queuedRun);

      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runtime-layer-archive-queued-archive"),
        threadId,
      });

      const archived = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(archived.thread.archivedAt);
      assert.equal(archived.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
      assert.equal(
        archived.attempts.find((attempt) => attempt.runId === queuedRun.id)?.status,
        "cancelled",
      );
      assert.equal(archived.nodes.find((node) => node.runId === queuedRun.id)?.status, "cancelled");
      assert.equal(yield* orchestrator.resumeQueuedRuns, 0);

      const promoteError = yield* orchestrator
        .dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("runtime-layer-archive-queued-promote"),
          threadId,
          queuedRunId: queuedRun.id,
          targetRunId: activeRun.id,
        })
        .pipe(Effect.flip);
      assert.equal(promoteError._tag, "OrchestratorDispatchError");

      const afterPromotion = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(afterPromotion.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
    }),
  );

  it.effect("starts a wake's work clock from the run that ran before it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-wake-work-start-thread");
      const messageId = (key: string) => MessageId.make(`runtime-layer-wake-work-start-${key}`);

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-wake-work-start-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-wake-work-start-project"),
        title: "Wake work start",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const dispatch = (key: string, wake: boolean) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: wake ? "agent" : "user",
          creationSource: wake ? "provider" : "web",
          ...(wake
            ? {
                notification: {
                  source: { kind: "background_task" as const },
                  outcome: "updated" as const,
                  summary: "Background activity updated",
                },
              }
            : {}),
          commandId: CommandId.make(`runtime-layer-wake-work-start-${key}`),
          threadId,
          messageId: messageId(key),
          text: key,
          attachments: [],
          modelSelection,
          dispatchMode:
            key === "prompt" ? { type: "start_immediately" } : { type: "queue_after_active" },
        });
      const runFor = (key: string) =>
        Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) => {
          const run = runs.find((candidate) => candidate.userMessageId === messageId(key));
          assert.isDefined(run);
          return run;
        });
      yield* dispatch("prompt", false);
      yield* dispatch("queued", false);
      yield* dispatch("early-wake", true);
      yield* orchestrator.dispatch({
        type: "queued-run.reorder",
        commandId: CommandId.make("runtime-layer-wake-work-start-reorder"),
        threadId,
        runId: (yield* runFor("queued")).id,
        beforeRunId: null,
      });
      yield* dispatch("late-wake", true);
      assert.isUndefined((yield* runFor("early-wake")).workStartedAt);

      const startedRunIds = yield* Queue.unbounded<RunId>();
      const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
      yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.runForEach((stored) =>
          stored.event.type === "run.updated" && stored.event.payload.status === "starting"
            ? Queue.offer(startedRunIds, stored.event.payload.id)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      const now = yield* DateTime.now;
      const settle = (key: string, startedAt: DateTime.Utc) =>
        Effect.gen(function* () {
          const run = yield* runFor(key);
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`runtime-layer-wake-work-start-${key}-completed`),
                type: "run.updated",
                threadId,
                runId: run.id,
                ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
                providerInstanceId: run.providerInstanceId,
                occurredAt: startedAt,
                payload: { ...run, status: "completed", startedAt, completedAt: startedAt },
              },
            ],
          });
        });
      const millis = (value: DateTime.Utc | undefined) =>
        value === undefined ? undefined : DateTime.toEpochMillis(value);

      yield* settle("prompt", now);
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("early-wake")).id);
      assert.equal(millis((yield* runFor("early-wake")).workStartedAt), millis(now));

      yield* settle("early-wake", DateTime.add(now, { seconds: 1 }));
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("queued")).id);
      assert.isUndefined((yield* runFor("queued")).workStartedAt);

      const queuedStartedAt = DateTime.add(now, { minutes: 10 });
      yield* settle("queued", queuedStartedAt);
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("late-wake")).id);
      assert.equal(millis((yield* runFor("late-wake")).workStartedAt), millis(queuedStartedAt));
    }),
  );
});

it.layer(layerSharedApplicationDataPlaneTest)("snooze projection", (it) => {
  it.effect("carries snooze state through the V2 shell projection", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-snoozed-project");
      const threadId = ThreadId.make("runtime-layer-snoozed-thread");
      const snoozedUntil = "2099-07-25T09:00:00.000Z";

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-snoozed-project-create"),
        projectId,
        title: "Snoozed shell projection",
        workspaceRoot: "/tmp/runtime-layer-snoozed-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-snoozed-thread-create"),
        threadId,
        projectId,
        title: "Snoozed thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze"),
        threadId,
        snoozedUntil,
      });

      const firstProjection = yield* orchestrator.getThreadProjection(threadId);
      const firstSnoozedAt = firstProjection.thread.snoozedAt;
      const firstUpdatedAt = firstProjection.thread.updatedAt;
      assert.isNotNull(firstSnoozedAt);

      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze-again"),
        threadId,
        snoozedUntil,
      });

      const shell = yield* orchestrator.getShellSnapshot();
      const thread = shell.threads.find((candidate) => candidate.id === threadId);
      assert.isDefined(thread);
      assert.equal(DateTime.formatIso(thread.snoozedUntil!), snoozedUntil);
      assert.deepEqual(thread.snoozedAt, firstSnoozedAt);
      assert.deepEqual(thread.updatedAt, firstUpdatedAt);

      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-wake"),
        threadId,
        reason: "user",
      });
      const projections = yield* ProjectionStore.ProjectionStoreV2.pipe(
        Effect.provide(ProjectionStore.layer),
      );
      const [candidate] = yield* projections.getSettlementCandidates(threadId);
      assert.deepEqual(candidate?.lastSnoozeWakeAt, yield* DateTime.now);
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze-after-wake"),
        threadId,
        snoozedUntil,
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-snoozed-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-snoozed-message"),
        text: "Wake this thread.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const awakened = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(awakened.thread.snoozedUntil);
      assert.isNull(awakened.thread.snoozedAt);
    }),
  );
});

it.layer(layerSharedApplicationDataPlaneTest)("thread environment move fence", (it) => {
  it.effect("fences mutations, preserves read state, and makes activation abort-proof", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const projectId = ProjectId.make("runtime-layer-move-project");
      const threadId = ThreadId.make("runtime-layer-move-thread");
      const providerThreadId = ProviderThreadId.make("runtime-layer-move-provider-thread");
      const destinationEnvironmentId = EnvironmentId.make("runtime-layer-move-destination");
      const nativeId = "019fbbc1-b12c-7360-a685-28c181f0025f";

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-move-project-create"),
        projectId,
        title: "Move project",
        workspaceRoot: "/tmp/runtime-layer-move-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-move-thread-create"),
        threadId,
        projectId,
        title: "Move thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "move-thread",
        worktreePath: "/tmp/runtime-layer-move-project/worktree",
      });
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("runtime-layer-move-provider-thread-event"),
            type: "provider-thread.updated",
            threadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: modelSelection.instanceId,
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              contextUsage: null,
              nativeMetadata: { itemIdentityVersion: 2 },
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });

      yield* outbox.enqueue([
        {
          id: "effect:runtime-layer-move-pending-checkpoint",
          commandId: CommandId.make("runtime-layer-move-pending-checkpoint"),
          threadId,
          request: { type: "terminal.cleanup" },
        },
      ]);
      const pendingEffectFence = yield* orchestrator
        .dispatch({
          type: "thread.move.fence",
          commandId: CommandId.make("runtime-layer-move-pending-effect-fence"),
          threadId,
          moveId: "move-pending-effect",
          destinationEnvironmentId,
        })
        .pipe(Effect.flip);
      assert.instanceOf(pendingEffectFence, Orchestrator.OrchestratorDispatchError);
      yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["terminal.cleanup"],
        reason: "test completed",
      });

      yield* orchestrator.dispatch({
        type: "thread.move.fence",
        commandId: CommandId.make("runtime-layer-move-fence"),
        threadId,
        moveId: "move-1",
        destinationEnvironmentId,
      });
      const mutation = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("runtime-layer-move-blocked-mutation"),
          threadId,
          title: "Must not change",
        })
        .pipe(Effect.flip);
      assert.instanceOf(mutation, Orchestrator.OrchestratorDispatchError);
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-move-visit"),
        threadId,
        visitedAt: "2026-10-05T12:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.move.abort",
        commandId: CommandId.make("runtime-layer-move-abort"),
        threadId,
        moveId: "move-1",
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-move-unfenced-mutation"),
        threadId,
        title: "Usable again",
      });

      yield* orchestrator.dispatch({
        type: "thread.move.fence",
        commandId: CommandId.make("runtime-layer-move-refence"),
        threadId,
        moveId: "move-2",
        destinationEnvironmentId,
      });
      yield* orchestrator.dispatch({
        type: "thread.move.activate",
        commandId: CommandId.make("runtime-layer-move-activate"),
        threadId,
        moveId: "move-2",
      });
      const lateAbort = yield* orchestrator
        .dispatch({
          type: "thread.move.abort",
          commandId: CommandId.make("runtime-layer-move-late-abort"),
          threadId,
          moveId: "move-2",
        })
        .pipe(Effect.flip);
      assert.instanceOf(lateAbort, Orchestrator.OrchestratorDispatchError);
      yield* orchestrator.dispatch({
        type: "thread.move.finalize",
        commandId: CommandId.make("runtime-layer-move-finalize"),
        threadId,
        moveId: "move-2",
        receipt: {
          version: 1,
          importId: "import-2",
          moveId: "move-2",
          threadId,
          destinationEnvironmentId,
          providerDriver: driver,
          nativeThreadId: nativeId,
          activatedAt: "2026-10-05T12:01:00.000Z",
          manifestSha256: "a".repeat(64),
        },
      });
      const moved = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(moved.thread.environmentMove);
      assert.isNull(moved.thread.archivedAt);
      assert.equal(moved.thread.settledOverride, "settled");
      assert.isNotNull(moved.thread.settledAt);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("runtime-layer-move-reopen"),
        threadId,
        messageId: MessageId.make("runtime-layer-move-reopen-message"),
        text: "Continue on the retained source",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      const reopened = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(reopened.thread.settledOverride);
      assert.isNull(reopened.thread.settledAt);
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("runtime-layer-move-delete"),
        threadId,
      });
      const deleted = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(deleted.thread.deletedAt);
    }),
  );
});

it.layer(layerActiveTerminalThreadMoveTest)(
  "thread environment move terminal eligibility",
  (it) => {
    it.effect("rejects an active terminal through the production serialized fence path", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const moves = yield* ThreadMoveService.ThreadMoveService;
        const projectId = ProjectId.make("runtime-layer-terminal-move-project");
        const threadId = ThreadId.make("runtime-layer-terminal-move-thread");
        const providerThreadId = ProviderThreadId.make("runtime-layer-terminal-move-provider");
        const now = yield* DateTime.now;

        yield* projects.create({
          commandId: CommandId.make("runtime-layer-terminal-move-project-create"),
          projectId,
          title: "Move project with terminal",
          workspaceRoot: "/tmp/runtime-layer-terminal-move-project",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("runtime-layer-terminal-move-thread-create"),
          threadId,
          projectId,
          title: "Move thread with terminal",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "move-terminal-thread",
          worktreePath: "/tmp/runtime-layer-terminal-move-project/worktree",
        });
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("runtime-layer-terminal-move-provider-event"),
              type: "provider-thread.updated",
              threadId,
              driver,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                id: providerThreadId,
                driver,
                providerInstanceId: modelSelection.instanceId,
                providerSessionId: null,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: "019fbbc1-b12c-7360-a685-28c181f0025f",
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                contextUsage: null,
                nativeMetadata: { itemIdentityVersion: 2 },
                createdAt: now,
                updatedAt: now,
              },
            },
          ],
        });

        const failure = yield* moves
          .fence({
            commandId: CommandId.make("runtime-layer-terminal-move-fence"),
            threadId,
            moveId: "move-active-terminal",
            destinationEnvironmentId: EnvironmentId.make("runtime-layer-terminal-destination"),
          })
          .pipe(Effect.flip);
        assert.equal(failure.reason, "active-terminal");
        assert.isUndefined(
          (yield* orchestrator.getThreadProjection(threadId)).thread.environmentMove,
        );
      }),
    );
  },
);

it.layer(layerTest)("usage-limit recovery", (it) => {
  it.effect.each(["interrupted", "usage_limit"] as const)(
    "manually resumes an %s run ahead of its queued message only once",
    (reason) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const events = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`manual-resume:${reason}`);
        const projectId = ProjectId.make(`manual-resume:project:${reason}`);
        const now = yield* DateTime.now;
        const createdAt = DateTime.formatIso(now);
        yield* seedProject({
          projectId,
          title: "Resume project",
          workspaceRoot: process.cwd(),
          defaultModelSelection: modelSelection,
          createdAt,
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`manual-resume:create:${reason}`),
          threadId,
          projectId,
          title: "Interrupted thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`manual-resume:start:${reason}`),
          threadId,
          messageId: MessageId.make(`manual-resume:start:${reason}`),
          text: "Start work.",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`manual-resume:queue:${reason}`),
          threadId,
          messageId: MessageId.make(`manual-resume:queue:${reason}`),
          text: "Follow up.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const [source, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
          OrchestrationV2Run,
          OrchestrationV2Run,
        ];
        // A user stop holds the queue as the run ends (thread.turn.interrupt with
        // holdQueue). Without the hold, the terminal-run worker may start the
        // queued run before the resume below, depending on fiber scheduling.
        yield* events.write({
          events: [
            {
              id: EventId.make(`manual-resume:hold:${reason}`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...queued, queueHeld: true },
            },
            {
              id: EventId.make(`manual-resume:stop:${reason}`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...source,
                status: reason === "interrupted" ? "interrupted" : "failed",
                completedAt: now,
              },
            },
          ],
        });
        let scheduledResume: ReturnType<typeof limitRecoveryCommand> = null;
        if (reason === "usage_limit") {
          const resetAt = DateTime.formatIso(DateTime.add(now, { minutes: 1 }));
          yield* events.write({
            events: [
              {
                id: EventId.make(`manual-resume:error:${reason}`),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`manual-resume:error:${reason}`),
                  type: "error",
                  threadId,
                  runId: source.id,
                  nodeId: source.rootNodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2,
                  status: "failed",
                  title: "Usage limit reached",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  failure: {
                    class: "usage_limit",
                    message: "Plan limit reached.",
                    code: "usageLimitExceeded",
                    retryable: null,
                    resetAt,
                  },
                },
              },
            ],
          });
          const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
            (thread) => thread.id === threadId,
          )!;
          yield* orchestrator.dispatch(
            limitRecoveryCommand(shell, true, DateTime.toEpochMillis(now))!,
          );
          const armed = (yield* orchestrator.getShellSnapshot()).threads.find(
            (thread) => thread.id === threadId,
          )!;
          scheduledResume = limitRecoveryCommand(armed, true, Date.parse(resetAt));
          assert.isNotNull(scheduledResume);
        }
        const resume = (suffix: string) => ({
          type: "message.dispatch" as const,
          commandId: CommandId.make(`manual-resume:${suffix}:${reason}`),
          threadId,
          messageId: MessageId.make(`manual-resume:${suffix}:${reason}`),
          manualContinuationOfRunId: source.id,
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" as const },
          createdBy: "user" as const,
          creationSource: "web" as const,
        });
        yield* orchestrator.dispatch(resume("first"));
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(after.runs, 3);
        assert.equal(after.runs[1]?.status, "queued");
        assert.equal(after.runs[2]?.status, "starting");
        assert.equal(
          (yield* orchestrator.dispatch(resume("second")).pipe(Effect.exit))._tag,
          "Failure",
        );
        if (scheduledResume !== null) {
          yield* TestClock.adjust("1 minute");
          yield* orchestrator.dispatch(scheduledResume);
        }
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 3);
      }),
  );

  it.effect.each([
    "resume",
    "queued-resume",
    "cancel",
    "rearm",
    "snooze-race",
    "new-message",
    "archive",
    "settle",
    "replacement",
    "manual-snooze",
    "manual-snooze-after-recovery",
    "invalid-snooze",
    "snooze-only",
    "snooze-resume",
    "cancel-resume-keep-snooze",
    "wake-preserve-resume",
    "independent-patches",
    "expired-snooze",
    "wake",
  ] as const)("guards a scheduled usage-limit continuation against %s", (scenario) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make(`recovery:${scenario}`);
      const projectId = ProjectId.make(`recovery:project:${scenario}`);
      yield* seedProject({
        projectId,
        title: "Recovery project",
        workspaceRoot: process.cwd(),
        defaultModelSelection: modelSelection,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`recovery:create:${scenario}`),
        threadId,
        projectId,
        title: "Limited thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`recovery:message:${scenario}`),
        threadId,
        messageId: MessageId.make(`recovery:message:${scenario}`),
        text: "Work on this.",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      if (scenario === "queued-resume") {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`recovery:queued:${scenario}`),
          threadId,
          messageId: MessageId.make(`recovery:queued:${scenario}`),
          text: "Run after recovery.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs[0]!;
      const now = yield* DateTime.now;
      const resetAt =
        scenario === "invalid-snooze"
          ? "not-a-date"
          : DateTime.formatIso(DateTime.add(now, { minutes: 1 })).replace(
              "Z",
              scenario === "wake" ? "+00:00" : "Z",
            );
      yield* events.write({
        commandId: CommandId.make(`recovery:failure:${scenario}`),
        events: [
          {
            id: EventId.make(`recovery:run:${scenario}`),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...run, status: "failed", completedAt: now },
          },
          {
            id: EventId.make(`recovery:error:${scenario}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`recovery:error:${scenario}`),
              type: "error",
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Usage limit reached",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "usage_limit",
                message: "Plan limit reached.",
                code: "usageLimitExceeded",
                retryable: null,
                resetAt,
              },
            },
          },
        ],
      });
      if (scenario === "queued-resume") {
        const queuedRun = projection.runs[1]!;
        yield* events.write({
          events: [
            {
              id: EventId.make("recovery:held:queued-resume"),
              type: "run.updated",
              threadId,
              runId: queuedRun.id,
              occurredAt: now,
              payload: { ...queuedRun, queueHeld: true },
            },
          ],
        });
        const resumeHeldQueue = yield* orchestrator
          .dispatch({
            type: "queue.resume",
            commandId: CommandId.make("recovery:resume-held:queued-resume"),
            threadId,
          })
          .pipe(Effect.exit);
        assert.equal(resumeHeldQueue._tag, "Failure");
        assert.isTrue((yield* orchestrator.getThreadProjection(threadId)).runs[1]?.queueHeld);
      }
      const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      )!;
      assert.isNull(limitRecoveryCommand(shell, false, DateTime.toEpochMillis(now)));
      if (scenario === "invalid-snooze") {
        const result = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("recovery:invalid-snooze"),
            threadId,
            limitRecovery: { runId: run.id, resetAt, snooze: true },
          })
          .pipe(Effect.exit);
        assert.equal(result._tag, "Failure");
        const current = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(current.thread.limitRecovery ?? null);
        assert.isNull(current.thread.snoozedUntil);
        return;
      }
      const snooze = [
        "snooze-only",
        "manual-snooze-after-recovery",
        "snooze-resume",
        "wake",
        "cancel-resume-keep-snooze",
        "wake-preserve-resume",
      ].includes(scenario);
      const autoResume = scenario !== "snooze-only" && scenario !== "wake";
      const arm = limitRecoveryCommand(shell, autoResume, DateTime.toEpochMillis(now), snooze);
      assert.isNotNull(arm);
      yield* orchestrator.dispatch(arm!);
      let armedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      )!;
      assert.deepEqual(armedShell.limitRecovery, {
        runId: run.id,
        resetAt,
        autoResume,
        snooze,
        requestId: arm!.commandId,
      });
      if (snooze)
        assert.equal(DateTime.toEpochMillis(armedShell.snoozedUntil!), Date.parse(resetAt));
      if (scenario === "cancel-resume-keep-snooze" || scenario === "wake-preserve-resume") {
        yield* TestClock.adjust("10 seconds");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:independent-choice:${scenario}`),
          threadId,
          limitRecovery: {
            runId: run.id,
            resetAt,
            autoResume: scenario === "wake-preserve-resume",
            snooze: scenario === "cancel-resume-keep-snooze",
          },
        });
        armedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        if (scenario === "cancel-resume-keep-snooze") {
          assert.equal(DateTime.toEpochMillis(armedShell.snoozedUntil!), Date.parse(resetAt));
          assert.equal(
            DateTime.toEpochMillis(armedShell.snoozedAt!),
            DateTime.toEpochMillis(armedShell.updatedAt),
          );
          assert.isFalse(armedShell.limitRecovery!.autoResume);
        } else {
          assert.isNull(armedShell.snoozedUntil);
          assert.isNull(armedShell.snoozedAt);
          assert.isTrue(armedShell.limitRecovery!.autoResume);
        }
      }
      if (scenario === "independent-patches") {
        yield* TestClock.adjust("10 seconds");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:patch-snooze"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, snooze: true },
        });
        let current = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(current.thread.limitRecovery!.autoResume);
        assert.isTrue(current.thread.limitRecovery!.snooze);
        yield* TestClock.adjust("10 seconds");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:patch-cancel-resume"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false },
        });
        current = yield* orchestrator.getThreadProjection(threadId);
        assert.isFalse(current.thread.limitRecovery!.autoResume);
        assert.isTrue(current.thread.limitRecovery!.snooze);
        assert.equal(DateTime.toEpochMillis(current.thread.snoozedUntil!), Date.parse(resetAt));
        assert.equal(
          DateTime.toEpochMillis(current.thread.snoozedAt!),
          DateTime.toEpochMillis(current.thread.updatedAt),
        );
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:patch-resume"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true },
        });
        armedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.isTrue(armedShell.limitRecovery!.autoResume);
        assert.isTrue(armedShell.limitRecovery!.snooze);
      }
      if (scenario === "manual-snooze" || scenario === "manual-snooze-after-recovery") {
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`recovery:manual-snooze:${scenario}`),
          threadId,
          snoozedUntil: resetAt,
        });
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:manual-cancel:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false, snooze: false },
        });
        assert.equal(
          DateTime.toEpochMillis(
            (yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil!,
          ),
          Date.parse(resetAt),
        );
        yield* orchestrator.dispatch({
          type: "thread.unsnooze",
          commandId: CommandId.make(`recovery:manual-wake:${scenario}`),
          threadId,
          reason: "user",
        });
        assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil);
      }
      if (scenario === "wake") {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:wake:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false, snooze: false },
        });
        assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil);
      }
      assert.isNull(limitRecoveryCommand(armedShell, true, DateTime.toEpochMillis(now)));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`recovery:early:${scenario}`),
        messageId: MessageId.make(`recovery:early:${scenario}`),
        threadId,
        usageLimitContinuationOfRunId: run.id,
        text: "Continue where you left off.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "server",
      });
      assert.lengthOf(
        (yield* orchestrator.getThreadProjection(threadId)).runs,
        scenario === "queued-resume" ? 2 : 1,
      );
      yield* TestClock.adjust("1 minute");
      const resume = limitRecoveryCommand(
        armedShell,
        true,
        DateTime.toEpochMillis(yield* DateTime.now),
      );
      if (autoResume && scenario !== "cancel-resume-keep-snooze") assert.isNotNull(resume);
      else assert.isNull(resume);
      if (scenario === "snooze-race") {
        const wakeAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 1 }));
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make("recovery:raced-snooze"),
          threadId,
          snoozedUntil: wakeAt,
        });
        yield* orchestrator.dispatch(resume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
        yield* TestClock.adjust("1 minute");
        const current = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        const freshResume = limitRecoveryCommand(
          current,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        assert.isNotNull(freshResume);
        assert.notEqual(freshResume!.commandId, resume!.commandId);
        yield* orchestrator.dispatch(freshResume!);
        yield* orchestrator.dispatch(freshResume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      }
      if (scenario === "expired-snooze") {
        const staleSnooze = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("recovery:expired-snooze"),
            threadId,
            limitRecovery: { runId: run.id, resetAt, snooze: true },
          })
          .pipe(Effect.exit);
        assert.equal(staleSnooze._tag, "Failure");
        const current = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(current.thread.snoozedUntil);
        assert.isFalse(current.thread.limitRecovery!.snooze);
        assert.isTrue(current.thread.limitRecovery!.autoResume);
      }

      if (scenario === "cancel" || scenario === "rearm")
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:cancel:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false },
        });
      if (scenario === "archive")
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`recovery:archive:${scenario}`),
          threadId,
        });
      if (scenario === "new-message")
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`recovery:new-message:${scenario}`),
          threadId,
          messageId: MessageId.make(`recovery:new-message:${scenario}`),
          text: "I will continue manually.",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
      if (scenario === "settle")
        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`recovery:settle:${scenario}`),
          threadId,
        });
      if (scenario === "replacement") {
        const current = yield* orchestrator.getThreadProjection(threadId);
        const error = current.turnItems.find((item) => item.type === "error")!;
        if (error.type !== "error") throw new Error("Expected provider error");
        yield* events.write({
          commandId: CommandId.make(`recovery:replacement:${scenario}`),
          events: [
            {
              id: EventId.make(`recovery:replacement:${scenario}`),
              type: "turn-item.updated",
              threadId,
              occurredAt: yield* DateTime.now,
              payload: {
                ...error,
                failure: {
                  ...error.failure,
                  class: "provider_error",
                  message: "A replacement failure.",
                },
              },
            },
          ],
        });
      }
      if (scenario === "rearm") {
        yield* orchestrator.dispatch(resume!);
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:rearm:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true },
        });
        yield* orchestrator.dispatch(resume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
        const rearmedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        const freshResume = limitRecoveryCommand(
          rearmedShell,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        assert.isNotNull(freshResume);
        assert.notEqual(freshResume!.commandId, resume!.commandId);
        yield* orchestrator.dispatch(freshResume!);
        yield* orchestrator.dispatch(freshResume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      if (resume !== null) {
        yield* orchestrator.dispatch(resume);
        yield* orchestrator.dispatch(resume);
      }
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(
        after.runs,
        before.runs.length +
          (scenario === "resume" ||
          scenario === "queued-resume" ||
          scenario === "snooze-resume" ||
          scenario === "wake-preserve-resume" ||
          scenario === "independent-patches" ||
          scenario === "expired-snooze"
            ? 1
            : 0),
      );
      assert.lengthOf(
        after.messages,
        before.messages.length +
          (scenario === "resume" ||
          scenario === "queued-resume" ||
          scenario === "snooze-resume" ||
          scenario === "wake-preserve-resume" ||
          scenario === "independent-patches" ||
          scenario === "expired-snooze"
            ? 1
            : 0),
      );
      if (scenario === "queued-resume") {
        assert.equal(after.runs[1]?.status, "queued");
        assert.isTrue(after.runs[1]?.queueHeld);
        const continuation = after.runs[2]!;
        const completedAt = yield* DateTime.now;
        yield* events.write({
          events: [
            {
              id: EventId.make("recovery:continuation-completed:queued-resume"),
              type: "run.updated",
              threadId,
              runId: continuation.id,
              occurredAt: completedAt,
              payload: { ...continuation, status: "completed", completedAt },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("recovery:resume-held-after-limit:queued-resume"),
          threadId,
        });
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        const resumedQueued = resumed.runs.find((run) => run.id === after.runs[1]?.id);
        assert.equal(resumedQueued?.status, "starting");
        assert.isFalse(resumedQueued?.queueHeld);
        assert.isAbove(resumedQueued!.ordinal, continuation.ordinal);
      }
    }),
  );
});

const queueResumeDisabledInstanceProjectId = ProjectId.make(
  "project:queue-resume-disabled-instance",
);

const layerQueueResumeDisabledInstanceTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(
    ServerSettings.layerTest({
      providerInstances: {
        [alternateInstanceId]: { driver: "codex", enabled: true },
      },
      projectSettingsOverrides: {
        [queueResumeDisabledInstanceProjectId]: {
          providerInstances: { [alternateInstanceId]: { enabled: false } },
        },
      },
    }),
  ),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

it.layer(Layer.fresh(layerSharedApplicationDataPlaneTest))("compact PR events", (it) => {
  it.effect("persists only the changed PR link and replays it without losing other links", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("compact-pr-sync");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("compact-pr-create"),
        threadId,
        projectId: ProjectId.make("compact-pr-project"),
        title: "PR sync",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code" };
      for (const number of [1, 2, 3]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`compact-pr-link-${number}`),
          threadId,
          ...key,
          number,
          url: `https://github.com/pingdotgg/t3code/pull/${number}`,
          source: "manual",
        });
      }
      const before = yield* orchestrator.getThreadShell(threadId);
      yield* orchestrator.dispatch({
        type: "thread.pull-request-link.sync",
        commandId: CommandId.make("compact-pr-sync"),
        threadId,
        ...key,
        number: 2,
        snapshot: {
          state: "open",
          title: "Updated PR",
          headBranch: "feature/pr",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-10-13T12:00:00.000Z",
        },
        stack: {
          kind: "native",
          id: "updated",
          number: 2,
          url: "https://github.com/pingdotgg/t3code/pull/2",
          base: "main",
          layers: [],
        },
      });
      const rows = yield* sql<{ event_type: string; payload_json: string }>`
        SELECT event_type, payload_json FROM orchestration_events
        WHERE command_id = ${"compact-pr-sync"}
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.event_type, "thread.pull-request-link-updated");
      const payload = JSON.parse(rows[0]!.payload_json);
      assert.equal(payload.number, 2);
      assert.isUndefined(payload.pullRequests);
      const after = yield* orchestrator.getThreadShell(threadId);
      assert.equal(after?.pullRequests?.length, 3);
      assert.deepEqual(after?.pullRequests?.[0], before?.pullRequests?.[0]);
      assert.deepEqual(after?.pullRequests?.[2], before?.pullRequests?.[2]);
      assert.equal(after?.pullRequests?.[1]?.stack?.id, "updated");
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests,
        after?.pullRequests,
      );
      // Later syncs of the same link supersede the ones between the first
      // (kept for replay order) and the newest.
      for (const [commandId, title] of [
        ["compact-pr-sync-again", "Still open PR"],
        ["compact-pr-sync-merged", "Merged PR"],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make(commandId),
          threadId,
          ...key,
          number: 2,
          snapshot: {
            state: title === "Merged PR" ? "merged" : "open",
            title,
            headBranch: "feature/pr",
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-10-13T13:00:00.000Z",
          },
          stack: null,
        });
      }
      const latest = yield* orchestrator.getThreadShell(threadId);
      yield* maintenance.compactEventStore();
      const linkEvents = yield* sql<{ command_id: string }>`
        SELECT command_id FROM orchestration_events
        WHERE stream_id = ${threadId} AND event_type = 'thread.pull-request-link-updated'
        ORDER BY sequence
      `;
      assert.deepEqual(
        linkEvents.map((row) => row.command_id),
        ["compact-pr-sync", "compact-pr-sync-merged"],
      );
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests,
        latest?.pullRequests,
      );

      // A later visit is read state only: clients keep updatedAt from the
      // rename, so compaction must keep the rename. Two visits supersede each
      // other, and a later rename supersedes a visit.
      const threadEvents = () => sql<{ event_type: string }>`
        SELECT event_type FROM orchestration_events
        WHERE stream_id = ${threadId}
          AND event_type IN ('thread.metadata-updated', 'thread.visited')
        ORDER BY sequence
      `;
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("compact-pr-rename"),
        threadId,
        title: "Renamed before visit",
      });
      for (const [commandId, visitedAt] of [
        ["compact-pr-visit", "2026-10-13T14:00:00.000Z"],
        ["compact-pr-visit-again", "2026-10-13T15:00:00.000Z"],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "thread.visit",
          commandId: CommandId.make(commandId),
          threadId,
          visitedAt,
        });
      }
      yield* maintenance.compactEventStore();
      assert.deepEqual(
        (yield* threadEvents()).map((row) => row.event_type),
        ["thread.metadata-updated", "thread.visited"],
      );
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("compact-pr-rename-again"),
        threadId,
        title: "Renamed after visit",
      });
      yield* maintenance.compactEventStore();
      assert.deepEqual(
        (yield* threadEvents()).map((row) => row.event_type),
        ["thread.metadata-updated"],
      );
    }),
  );
});
