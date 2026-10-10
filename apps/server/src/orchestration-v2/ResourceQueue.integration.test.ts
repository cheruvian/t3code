import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProjectResourceLock,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layerMemory } from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Resource queue tests must not launch a provider"),
} as ProviderAdapterV2Shape;
const database = layerMemory;
const testLayer = Layer.mergeAll(
  ProjectStore.layer.pipe(Layer.provide(database)),
  ProjectionStore.layer.pipe(Layer.provide(database)),
  layerWithRegistry(
    { name: "resource-queue" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);
const threadId = ThreadId.make("thread:resource-queue");
const projectId = ProjectId.make("project:resource-queue");
const operationId = CommandId.make("resource-operation");
const lock: ProjectResourceLock = {
  threadId,
  operationId,
  phase: "checkout",
  script: {
    id: "device",
    name: "Device",
    command: "checkout-device",
    icon: "configure",
    runOnWorktreeCreate: false,
    resource: {
      color: "#abcdef",
      checkoutPrompt: "",
      releaseCommand: "release-device",
      releasePrompt: "",
    },
  },
};
const setLocks = (resourceLocks: ReadonlyArray<ProjectResourceLock>) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* projects.apply({
      type: "project.created",
      sequence: 1,
      eventId: EventId.make("project-fixture"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        projectId,
        title: "Queue fixture",
        workspaceRoot: "/tmp",
        defaultModelSelection: modelSelection,
        scripts: [lock.script],
        resourceLocks,
        createdAt: now,
        updatedAt: now,
      },
    });
  });
const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* setLocks([lock]);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId,
    title: "Resource queue",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return { orchestrator, projections: yield* ProjectionStore.ProjectionStoreV2 };
});

it.effect.each(["checkout", "release"] as const)(
  "queues messages during %s without an active provider and resumes after completion",
  (phase) =>
    Effect.gen(function* () {
      const { orchestrator, projections } = yield* setup;
      yield* setLocks([{ ...lock, phase }]);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send"),
        threadId,
        messageId: MessageId.make("message"),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      let projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.runs.length, 1);
      assert.equal(projection.runs[0]!.status, "queued");
      assert.equal(projection.providerSessions.length, 0);
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-blocked"),
        threadId,
      });
      assert.equal((yield* projections.getThreadProjection(threadId)).runs[0]!.status, "queued");
      yield* setLocks(phase === "checkout" ? [{ ...lock, phase: "held" }] : []);
      yield* orchestrator.resumeQueuedRuns;
      projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.runs[0]!.status, "starting");
    }).pipe(Effect.provide(testLayer)),
);

it.effect("unpauses a queue during recovery work without interrupting the active run", () =>
  Effect.gen(function* () {
    const { orchestrator, projections } = yield* setup;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("waiting-message"),
      threadId,
      messageId: MessageId.make("waiting-message"),
      text: "Wait until ready",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    const queued = (yield* projections.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("held-after-restart"),
      type: "run.updated",
      threadId,
      runId: queued.id,
      occurredAt: yield* DateTime.now,
      payload: { ...queued, queueHeld: true },
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("recovery-hook"),
      threadId,
      messageId: MessageId.make("recovery-hook"),
      text: "Prepare device",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "system",
      creationSource: "server",
      resourceOperationId: operationId,
    });
    const active = (yield* projections.getThreadProjection(threadId)).runs.find(
      (run) => run.userMessageId === "recovery-hook",
    )!;
    assert.equal(active.status, "starting");
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("unpause-during-recovery"),
      threadId,
    });
    let projection = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(
      projection.runs.find((run) => run.id === active.id),
      active,
    );
    assert.equal(projection.runs.find((run) => run.id === queued.id)!.status, "queued");
    assert.equal(projection.runs.find((run) => run.id === queued.id)!.queueHeld, false);

    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("finish-recovery-hook"),
      threadId,
      runId: active.id,
      holdQueue: false,
    });
    // Recovery still owns the resource after its hook stops.
    yield* orchestrator.resumeQueuedRuns;
    assert.equal(
      (yield* projections.getThreadProjection(threadId)).runs.find((run) => run.id === queued.id)!
        .status,
      "queued",
    );
    yield* setLocks([{ ...lock, phase: "held" }]);
    yield* orchestrator.resumeQueuedRuns;
    projection = yield* projections.getThreadProjection(threadId);
    assert.equal(projection.runs.find((run) => run.id === queued.id)!.status, "starting");
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  { createdBy: "system" as const, creationSource: "server" as const, operationId, allowed: true },
  { createdBy: "user" as const, creationSource: "web" as const, operationId, allowed: false },
  { createdBy: "system" as const, creationSource: "web" as const, operationId, allowed: false },
  {
    createdBy: "system" as const,
    creationSource: "server" as const,
    operationId: CommandId.make("other"),
    allowed: false,
  },
])("checks resource hook identity $createdBy/$creationSource/$operationId", (identity) =>
  Effect.gen(function* () {
    const { orchestrator, projections } = yield* setup;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("hook"),
      threadId,
      messageId: MessageId.make("hook-message"),
      text: "Resource hook",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: identity.createdBy,
      creationSource: identity.creationSource,
      resourceOperationId: identity.operationId,
    });
    const projection = yield* projections.getThreadProjection(threadId);
    assert.equal(projection.runs[0]!.status, identity.allowed ? "starting" : "queued");
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "runs a trusted hook ahead of waiting messages and preserves their queue at hook termination",
  () =>
    Effect.gen(function* () {
      const { orchestrator, projections } = yield* setup;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("normal"),
        threadId,
        messageId: MessageId.make("normal-message"),
        text: "Wait for the device",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("hook"),
        threadId,
        messageId: MessageId.make("hook-message"),
        text: "Prepare device",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "system",
        creationSource: "server",
        resourceOperationId: operationId,
      });
      let projection = yield* projections.getThreadProjection(threadId);
      const normal = projection.runs.find((run) => run.userMessageId === "normal-message")!;
      const hook = projection.runs.find((run) => run.userMessageId === "hook-message")!;
      assert.equal(normal.status, "queued");
      assert.equal(hook.status, "starting");
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("stop-hook"),
        threadId,
        runId: hook.id,
        holdQueue: false,
      });
      yield* orchestrator.resumeQueuedRuns;
      projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.runs.find((run) => run.id === hook.id)!.status, "interrupted");
      assert.equal(projection.runs.find((run) => run.id === normal.id)!.status, "queued");
      yield* setLocks([{ ...lock, phase: "held" }]);
      yield* orchestrator.resumeQueuedRuns;
      projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.runs.find((run) => run.id === normal.id)!.status, "starting");
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(
  (["checkout", "release", "held", "failed"] as const).flatMap((phase) =>
    (["thread.archive", "thread.delete"] as const).map((type) => ({ phase, type })),
  ),
)("$type retains a thread with a $phase reservation until release", ({ phase, type }) =>
  Effect.gen(function* () {
    const { orchestrator, projections } = yield* setup;
    yield* setLocks([{ ...lock, phase }]);
    const rejected = yield* Effect.exit(
      orchestrator.dispatch({ type, commandId: CommandId.make("remove-blocked"), threadId }),
    );
    assert.equal(rejected._tag, "Failure");
    const before = yield* projections.getThreadProjection(threadId);
    assert.equal(before.thread.archivedAt, null);
    assert.equal(before.thread.deletedAt, null);
    yield* setLocks([]);
    yield* orchestrator.dispatch({
      type,
      commandId: CommandId.make("remove-released"),
      threadId,
    });
    const after = yield* projections.getThreadProjection(threadId);
    assert.isNotNull(type === "thread.archive" ? after.thread.archivedAt : after.thread.deletedAt);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps server-originated notifications queued during a resource action", () =>
  Effect.gen(function* () {
    const { orchestrator, projections } = yield* setup;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("notification"),
      threadId,
      messageId: MessageId.make("notification-message"),
      text: "Build complete",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
      resourceOperationId: operationId,
      notification: { source: { kind: "monitor" }, outcome: "updated", summary: "Build complete" },
    });
    assert.equal((yield* projections.getThreadProjection(threadId)).runs[0]!.status, "queued");
    assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
    yield* setLocks([]);
    assert.equal(yield* orchestrator.resumeQueuedRuns, 1);
    assert.equal((yield* projections.getThreadProjection(threadId)).runs[0]!.status, "starting");
  }).pipe(Effect.provide(testLayer)),
);
