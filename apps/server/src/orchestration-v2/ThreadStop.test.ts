import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as EventStore from "./EventStore.ts";
import * as EventSink from "./EventSink.ts";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CLAUDE_PROVIDER } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const unused = () => Effect.die("No provider work runs in Stop tests");
      return {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          status: "ready",
          cwd: process.cwd(),
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.never,
        ensureThread: unused,
        resumeThread: unused,
        startTurn: unused,
        steerTurn: unused,
        interruptTurn: unused,
        respondToRuntimeRequest: ({ requestId }) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
              driver: ProviderDriverKind.make("codex"),
              requestId,
              cause: "Provider rejected the answer",
            }),
          ),
        readThreadSnapshot: unused,
        rollbackThread: unused,
        forkThread: unused,
      } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
    }),
} satisfies ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-stop" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const encodeEffectRequest = Schema.encodeSync(Schema.fromJsonString(OrchestrationEffectRequestV2));

const pullRequest = (number: number) => ({
  host: "github.com",
  repository: "pingdotgg/t3code",
  number,
});

const createWatchingThread = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-stop"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* watch(threadId, number);
  });

const watch = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`watch:${threadId}:${number}`),
      threadId,
      ...pullRequest(number),
      watching: true,
      link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
    });
  });

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

const threadState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return {
      runs: projection.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`),
      watched: (projection.thread.pullRequests ?? [])
        .filter((link) => link.watch !== undefined)
        .map((link) => link.number),
    };
  });

it.effect.each([
  ["idle", "thread.stop"],
  ["idle", "run.interrupt"],
  ["idle", "subagent.stop"],
  ["running", "subagent.stop"],
  ["bound", "subagent.stop"],
  ["correlated", "subagent.stop"],
  ["archived", "thread.stop"],
  ["missing", "thread.stop"],
  ["running", "thread.stop"],
  ["queued", "thread.stop"],
  ["waiting", "thread.stop"],
  ["correlated", "thread.stop"],
  ["provider-active", "thread.stop"],
  ["roster", "thread.stop"],
  ["background", "thread.stop"],
  ["question", "thread.stop"],
  ["restart", "thread.stop"],
] as const)(
  "Stop clears an orphaned follow-up when its child is finished; its own Stop does unless a run is bound (%s via %s)",
  ([childState, type]) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parentThreadId = ThreadId.make(`thread:orphan-parent:${childState}`);
      yield* createWatchingThread(parentThreadId, 1);
      yield* send(parentThreadId, "parent", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, "original task");
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const child = yield* orchestrator.getThreadProjection(childThreadId);
      const original = parent.subagents[0]!;
      const originalItem = parent.turnItems.find((item) => item.type === "subagent")!;
      const originalNode = parent.nodes.find((node) => node.id === original.id)!;
      const taskId = NodeId.make(`node:orphan-followup:${childState}`);
      const itemId = TurnItemId.make(`item:orphan-followup:${childState}`);
      const followupChildThreadId =
        childState === "missing" ? ThreadId.make("thread:missing-child") : childThreadId;
      const now = yield* DateTime.now;
      let sequence = 0;
      const apply = (event: Omit<OrchestrationV2DomainEvent, "id">) =>
        projections.apply({
          ...event,
          id: EventId.make(`event:orphan:${childState}:${sequence++}`),
        } as OrchestrationV2DomainEvent);
      yield* apply({
        type: "subagent.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...original,
          status: "completed",
          result: "Original result",
          completedAt: now,
          completionDelivery: { state: "acknowledged", observedByRunId: null },
        },
      });
      yield* apply({
        type: "context-transfer.created",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...child.contextTransfers[0]!,
          id: ContextTransferId.make(`transfer:original-result:${childState}`),
          type: "subagent_result",
          sourceThreadId: childThreadId,
          targetThreadId: parentThreadId,
          sourcePoint: { threadId: childThreadId, runId: child.runs[0]!.id },
          targetRunId: parent.runs[0]!.id,
        },
      });
      yield* apply({
        type: "node.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...originalNode, status: "completed", completedAt: now },
      });
      yield* apply({
        type: "turn-item.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...originalItem, status: "completed", completedAt: now },
      });
      yield* apply({
        type: "subagent.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...original,
          id: taskId,
          childThreadId: followupChildThreadId,
          status: "running",
          result: null,
          completedAt: null,
        },
      });
      yield* apply({
        type: "node.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...originalNode, id: taskId, status: "running" },
      });
      assert.equal(originalItem.type, "subagent");
      if (originalItem.type !== "subagent") return;
      yield* apply({
        type: "turn-item.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...originalItem,
          id: itemId,
          nodeId: taskId,
          subagentId: taskId,
          childThreadId: followupChildThreadId,
          status: "running",
        },
      });
      const runAtStart = child.runs[0]!;
      const childRunStatus =
        childState === "running" || childState === "queued" || childState === "waiting"
          ? childState
          : childState === "bound"
            ? "running"
            : "completed";
      yield* apply({
        type: "run.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: { ...runAtStart, status: "running", delegatedTaskId: taskId },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]?.delegatedTaskId,
        taskId,
      );
      // A terminal write based on the attempt's start snapshot loses a later steer binding.
      yield* apply({
        type: "run.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: {
          ...runAtStart,
          status: childRunStatus,
          completedAt: childRunStatus === "completed" ? now : null,
          ...(childState === "correlated" || childState === "bound"
            ? { delegatedTaskId: taskId }
            : {}),
        },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]?.delegatedTaskId,
        childState === "correlated" || childState === "bound" ? taskId : undefined,
      );
      if (childState === "provider-active" || childState === "roster") {
        yield* apply({
          type: "provider-thread.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            ...child.providerThreads[0]!,
            status: childState === "provider-active" ? "active" : "idle",
            pendingBackgroundTasks:
              childState === "roster" ? [{ taskId: "background-task", kind: "command" }] : [],
          },
        });
      }
      if (childState === "background") {
        yield* apply({
          type: "turn-item.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            ...originalItem,
            id: TurnItemId.make("item:child-background"),
            threadId: childThreadId,
            runId: runAtStart.id,
            nodeId: runAtStart.rootNodeId,
            type: "command_execution",
            status: "running",
            input: "test background work",
          },
        });
      }
      if (childState === "question") {
        yield* apply({
          type: "runtime-request.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("request:child-question"),
            nodeId: runAtStart.rootNodeId!,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
      }
      if (childState === "restart") {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* outbox.enqueue([
          {
            id: `effect:restart-continuation:${runAtStart.id}`,
            commandId: CommandId.make("command:child-restart"),
            threadId: childThreadId,
            request: { type: "provider-runtime.continue", sourceRunId: runAtStart.id },
          },
        ]);
      }
      yield* apply({
        type: "run.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...parent.runs[0]!, status: "completed", completedAt: now },
      });
      if (type === "run.interrupt") {
        const run = parent.runs[0]!;
        yield* apply({
          type: "provider-turn.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: {
            id: ProviderTurnId.make("provider-turn:orphan-parent"),
            providerThreadId: run.providerThreadId!,
            nodeId: run.rootNodeId!,
            runAttemptId: run.activeAttemptId!,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: now,
            completedAt: now,
          },
        });
        yield* apply({
          type: "run-attempt.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: { ...parent.attempts[0]!, status: "completed", completedAt: now },
        });
        yield* apply({
          type: "node.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: {
            ...parent.nodes.find((node) => node.id === run.rootNodeId)!,
            status: "completed",
            completedAt: now,
          },
        });
      }
      if (childState === "archived") {
        yield* apply({
          type: "thread.archived",
          threadId: childThreadId,
          occurredAt: now,
          payload: { ...child.thread, archivedAt: now },
        });
      }
      const childBeforeStop = yield* orchestrator.getThreadProjection(childThreadId);
      assert.lengthOf(
        ((yield* orchestrator.getThreadShell(parentThreadId))?.pendingBackgroundTasks ?? []).filter(
          (task) => task.kind === "subagent",
        ),
        1,
      );
      const stop = {
        commandId: CommandId.make(`stop-orphan:${childState}`),
        threadId: parentThreadId,
      };
      yield* orchestrator.dispatch(
        type === "run.interrupt"
          ? { ...stop, type, runId: parent.runs.at(-1)!.id, holdQueue: true }
          : type === "subagent.stop"
            ? { ...stop, type, runId: original.runId!, subagentId: taskId }
            : { ...stop, type },
      );
      const after = yield* orchestrator.getThreadProjection(parentThreadId);
      // The Lineage stop of one subagent leaves the parent's watches alone.
      assert.lengthOf(
        (after.thread.pullRequests ?? []).filter((link) => link.watch !== undefined),
        type === "subagent.stop" ? 1 : 0,
      );
      // A task with a bound run, live or ended, keeps its settlement path.
      const expected =
        childState === "bound" || childState === "correlated"
          ? "running"
          : type === "subagent.stop" || childState === "idle" || childState === "archived"
            ? "cancelled"
            : "running";
      assert.equal(after.subagents.find((task) => task.id === taskId)?.status, expected);
      assert.equal(after.nodes.find((node) => node.id === taskId)?.status, expected);
      assert.equal(after.turnItems.find((item) => item.id === itemId)?.status, expected);
      assert.equal(
        after.subagents.find((task) => task.id === taskId)?.completionDelivery?.state,
        type === "subagent.stop" && expected === "running" ? undefined : "disposed",
      );
      assert.equal(
        after.subagents.find((task) => task.id === original.id)?.result,
        "Original result",
      );
      assert.deepEqual(yield* orchestrator.getThreadProjection(childThreadId), childBeforeStop);
      if (expected === "cancelled") {
        assert.lengthOf(
          (
            (yield* orchestrator.getThreadShell(parentThreadId))?.pendingBackgroundTasks ?? []
          ).filter((task) => task.kind === "subagent"),
          0,
        );
        yield* orchestrator.recoverDelegatedTasks;
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`stop-orphan-again:${childState}`),
          threadId: parentThreadId,
        });
        const repeated = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.equal(repeated.subagents.find((task) => task.id === taskId)?.status, "cancelled");
        assert.deepEqual(repeated.messages, after.messages);
        assert.deepEqual(repeated.contextTransfers, after.contextTransfers);
        if (type === "subagent.stop") {
          // A client that missed the cancel, such as one resumed from an older cache, still
          // shows the task as running. Its Stop gets the ended task back.
          const eventStore = yield* EventStore.EventStoreV2;
          const afterSequence = yield* eventStore.latestSequence({ threadId: parentThreadId });
          yield* orchestrator.dispatch({
            ...stop,
            commandId: CommandId.make(`stop-orphan-stale-client:${childState}`),
            type,
            runId: original.runId!,
            subagentId: taskId,
          });
          const resent = yield* eventStore
            .read({ threadId: parentThreadId, afterSequence })
            .pipe(Stream.runCollect);
          assert.deepEqual(
            resent.flatMap(({ event }) =>
              event.type === "subagent.updated" ? [event.payload.status] : [],
            ),
            ["cancelled"],
          );
        }
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect("Stop still stops the thread when a delegated child cannot be read", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const parentThreadId = ThreadId.make("thread:unreadable-child-parent");
    yield* createWatchingThread(parentThreadId, 1);
    yield* send(parentThreadId, "parent", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "unreadable child");
    yield* sql`
      UPDATE orchestration_v2_projection_runs
      SET payload_json = '{"obsolete":true}'
      WHERE thread_id = ${childThreadId}
    `;
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("stop:unreadable-child"),
      threadId: parentThreadId,
      runId: (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!.id,
      holdQueue: true,
    });
    assert.deepEqual(yield* threadState(parentThreadId), { runs: ["interrupted"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["run.interrupt", "thread.stop"] as const)(
  "%s Stop ends watches, holds queues, and stops the delegated tasks under the thread",
  (type) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      const parentThreadId = ThreadId.make("thread:stop-parent");
      yield* createWatchingThread(parentThreadId, 1);
      yield* send(parentThreadId, "first", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, "child task");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(childThreadId, 2))));
      const grandchildThreadId = yield* delegate(childThreadId, "grandchild task");
      yield* send(childThreadId, "child follow-up", "queue_after_active");

      const now = yield* DateTime.now;
      const firstRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
      yield* projections.apply({
        id: EventId.make("event:stop-parent:first-run-completed"),
        type: "run.updated",
        threadId: parentThreadId,
        runId: firstRun.id,
        occurredAt: now,
        payload: { ...firstRun, status: "completed", completedAt: now },
      });
      yield* send(parentThreadId, "second", "start_immediately");
      const secondRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;

      const stopCommandId = CommandId.make("stop-parent");
      yield* orchestrator.dispatch(
        type === "thread.stop"
          ? { type, commandId: stopCommandId, threadId: parentThreadId }
          : {
              type,
              commandId: stopCommandId,
              threadId: parentThreadId,
              runId: secondRun.id,
              holdQueue: true,
            },
      );

      assert.deepEqual(yield* threadState(parentThreadId), {
        runs: ["completed", "interrupted"],
        watched: [],
      });
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      assert.equal(parent.subagents[0]?.completionDelivery?.state, "disposed");
      const effects = yield* sql<{ readonly effect_type: string }>`
      SELECT effect_type FROM orchestration_v2_effect_outbox WHERE command_id = ${stopCommandId}
    `;
      assert.include(
        effects.map((row) => row.effect_type),
        "delegated-tasks.stop",
      );

      yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
      assert.deepEqual(yield* threadState(childThreadId), {
        runs: ["interrupted", "queued:held"],
        watched: [],
      });
      assert.deepEqual((yield* threadState(grandchildThreadId)).runs, ["interrupted"]);

      yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
      assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted", "queued:held"]);
      // The walk stops each level itself, so the child stops it sends queue no walk of their own.
      const walks = yield* sql<{ readonly command_id: string }>`
      SELECT command_id FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'delegated-tasks.stop'
    `;
      assert.deepEqual(
        walks.map((row) => row.command_id),
        [stopCommandId],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a repeated Stop that changes nothing still stops the delegated tasks", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const parentThreadId = ThreadId.make("thread:stop-again");
    yield* createWatchingThread(parentThreadId, 1);
    yield* send(parentThreadId, "first", "start_immediately");
    yield* delegate(parentThreadId, "stop-again child");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-again:run-completed"),
      type: "run.updated",
      threadId: parentThreadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    });
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-again:first"),
      threadId: parentThreadId,
    });

    // The first Stop already disposed the delivery and ended the watch, so this one writes no
    // events, like Stop on a thread an older server stopped without stopping its children.
    const again = yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-again:second"),
      threadId: parentThreadId,
    });
    assert.lengthOf(again.storedEvents, 0);
    const walks = yield* sql<{ readonly command_id: string }>`
      SELECT command_id FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'delegated-tasks.stop'
    `;
    assert.deepEqual(
      walks.map((row) => row.command_id),
      ["stop-again:first", "stop-again:second"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "%s cancels buffered wakes and preserves durable queued messages",
  (type) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make(`thread:stop-buffered:${type}`);
      yield* createWatchingThread(threadId, 5);
      yield* send(threadId, "active", "start_immediately");
      yield* send(threadId, "user follow-up", "queue_after_active");
      for (const creationSource of ["provider", "server"] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`notification:${type}:${creationSource}`),
          threadId,
          messageId: MessageId.make(`notification:${type}:${creationSource}`),
          text: "Background activity updated",
          attachments: [],
          createdBy: "agent",
          creationSource,
          notification: {
            source: { kind: "background_task" },
            outcome: "updated",
            summary: "Background activity updated",
          },
          dispatchMode: { type: "queue_after_active" },
        });
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      const buffered = before.runs.find((run) =>
        before.messages.some(
          (message) => message.id === run.userMessageId && message.creationSource === "provider",
        ),
      )!;
      const stop = { commandId: CommandId.make(`stop:${type}`), threadId };
      yield* orchestrator.dispatch(
        type === "run.interrupt"
          ? { ...stop, type, runId: before.runs[0]!.id, holdQueue: true }
          : { ...stop, type },
      );
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(stopped.runs.find((run) => run.id === buffered.id)?.status, "cancelled");
      assert.equal(
        stopped.attempts.find((attempt) => attempt.runId === buffered.id)?.status,
        "cancelled",
      );
      assert.equal(
        stopped.nodes.find((node) => node.id === buffered.rootNodeId)?.status,
        "cancelled",
      );
      assert.deepEqual(
        stopped.runs.filter((run) => run.status === "queued").map((run) => run.queueHeld),
        [true, true],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a message the user sends after Stop releases the held queue; an agent's does not", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-release");
    const agentSend = (text: string) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`agent-send:${text}`),
        threadId,
        messageId: MessageId.make(`message:${threadId}:${text}`),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "mcp",
      });
    yield* createWatchingThread(threadId, 6);
    yield* send(threadId, "active", "start_immediately");
    yield* send(threadId, "queued before the stop", "queue_after_active");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-release"),
      threadId,
    });
    assert.deepEqual((yield* threadState(threadId)).runs, ["interrupted", "queued:held"]);

    // An agent's message starts on the idle thread, but the hold is the user's.
    yield* agentSend("agent nudge");
    assert.deepEqual((yield* threadState(threadId)).runs, [
      "interrupted",
      "queued:held",
      "starting",
    ]);
    const nudge = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:stop-release:nudge-completed"),
      type: "run.updated",
      threadId,
      runId: nudge.id,
      occurredAt: now,
      payload: { ...nudge, status: "completed", completedAt: now },
    });

    // A scheduled task the user created is not the user coming back.
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("scheduled-send"),
      threadId,
      messageId: MessageId.make(`message:${threadId}:scheduled`),
      text: "Nightly check",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
      scheduledTaskId: ScheduledTaskId.make("scheduled:nightly"),
    });
    const scheduled = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    assert.deepEqual((yield* threadState(threadId)).runs, [
      "interrupted",
      "queued:held",
      "completed",
      "starting",
    ]);
    yield* projections.apply({
      id: EventId.make("event:stop-release:scheduled-completed"),
      type: "run.updated",
      threadId,
      runId: scheduled.id,
      occurredAt: now,
      payload: { ...scheduled, status: "completed", completedAt: now },
    });

    // The user is back: the held message follows their run, and a wake that
    // queues behind it is not held by the old Stop.
    yield* send(threadId, "back", "start_immediately");
    yield* agentSend("task finished");
    assert.deepEqual((yield* threadState(threadId)).runs, [
      "interrupted",
      "queued",
      "completed",
      "completed",
      "starting",
      "queued",
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "thread.stop ends an idle thread's watches and accepts a thread with nothing to stop",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:stop-idle");
      yield* createWatchingThread(threadId, 3);

      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-idle"),
        threadId,
      });
      assert.deepEqual(yield* threadState(threadId), { runs: [], watched: [] });

      const again = yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-idle-again"),
        threadId,
      });
      assert.lengthOf(again.storedEvents, 0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])(
  "a completed watch records whether it ended through Stop (%s)",
  (stopped) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make(`thread:watch-completion:${stopped}`);
      yield* createWatchingThread(threadId, 7);
      yield* send(threadId, "watch", "start_immediately");
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      const completedRun = {
        ...run,
        providerThreadId: run.providerThreadId ?? ProviderThreadId.make("provider-thread:watch"),
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      };
      yield* projections.apply({
        id: EventId.make("event:watch-completed"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: completedRun,
      });
      assert.isFalse((yield* projections.getThreadShell(threadId))?.latestRunStopRequested);

      yield* orchestrator.dispatch(
        stopped
          ? { type: "thread.stop", commandId: CommandId.make("stop-watch"), threadId }
          : {
              type: "thread.pull-request.watch",
              commandId: CommandId.make("finish-watch"),
              threadId,
              ...pullRequest(7),
              watching: false,
            },
      );
      const shell = yield* projections.getThreadShell(threadId);
      const snapshot = (yield* projections.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      const memoryShell = ProjectionStore.threadShellFromProjection(
        yield* orchestrator.getThreadProjection(threadId),
      );
      for (const result of [shell, snapshot, memoryShell]) {
        assert.equal(result?.status, "completed");
        assert.isEmpty(result?.pendingBackgroundTasks ?? []);
        assert.equal(result?.latestRunStopRequested, stopped);
      }

      yield* send(threadId, "next", "start_immediately");
      assert.isFalse((yield* projections.getThreadShell(threadId))?.latestRunStopRequested);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a run Stop reached cannot delegate or start a watch, even after it ends", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-barrier");
    yield* createWatchingThread(threadId, 4);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = { ...(yield* orchestrator.getThreadProjection(threadId)).runs[0]!, startedAt: now };
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:running"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running" },
    });
    yield* send(threadId, "queued", "queue_after_active");
    const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel-queued"),
      threadId,
      runId: queued.id,
    });
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:interrupt-request"),
      type: "turn-item.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:stop-barrier:interrupt-request"),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        providerThreadId: run.providerThreadId!,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1_000,
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: "Stop",
      },
    });

    assert.isTrue(Exit.isFailure(yield* Effect.exit(delegate(threadId, "late task"))));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 5))));

    yield* projections.apply({
      id: EventId.make("event:stop-barrier:interrupted"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "interrupted", completedAt: now },
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 5))));
    assert.deepEqual(yield* threadState(threadId), {
      runs: ["interrupted", "cancelled"],
      watched: [4],
    });

    for (const watching of [false, true]) {
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`manual-watch:${watching}`),
        threadId,
        ...pullRequest(4),
        watching,
      });
    }
    assert.deepEqual((yield* threadState(threadId)).watched, [4]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop keeps a restart continuation of the stopped run from starting", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:stop-restart");
    yield* createWatchingThread(threadId, 8);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-restart:cancelled"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "cancelled", startedAt: null, completedAt: now },
    });
    const at = DateTime.formatIso(now);
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        attempt_count, available_at, created_at, updated_at
      ) VALUES (
        ${`effect:restart-continuation:${run.id}`}, 'command:restart', ${threadId},
        'provider-runtime.continue',
        ${encodeEffectRequest({ type: "provider-runtime.continue", sourceRunId: run.id })},
        'pending', 0, ${at}, ${at}, ${at}
      )
    `;

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-restart"),
      threadId,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("restart-continuation"),
      threadId,
      messageId: MessageId.make("message:restart-continuation"),
      text: "Continue.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      restartContinuationOfRunId: run.id,
    });
    assert.deepEqual(yield* threadState(threadId), { runs: ["cancelled"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "a successful %s blocks a newer restart continuation when completion timestamps tie",
  (stopType) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:stop-resumed-queue");
      yield* createWatchingThread(threadId, 12);
      yield* send(threadId, "first", "start_immediately");
      yield* send(threadId, "queued", "queue_after_active");
      const now = yield* DateTime.now;
      const [first, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.isDefined(first);
      assert.isDefined(queued);
      for (const run of [first!, queued!]) {
        yield* projections.apply({
          id: EventId.make(`event:stop-resumed-queue:hold:${run.id}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload:
            run.id === first!.id
              ? { ...run, status: "completed", completedAt: now }
              : { ...run, queueHeld: true },
        });
      }
      yield* send(threadId, "restart source", "start_immediately");
      const source = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      yield* projections.apply({
        id: EventId.make("event:stop-resumed-queue:restart-cancelled"),
        type: "run.updated",
        threadId,
        runId: source.id,
        occurredAt: now,
        payload: { ...source, status: "cancelled", startedAt: now, completedAt: now },
      });
      const at = DateTime.formatIso(now);
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at
        ) VALUES (
          ${`effect:restart-continuation:${source.id}`}, 'command:restart', ${threadId},
          'provider-runtime.continue',
          ${encodeEffectRequest({ type: "provider-runtime.continue", sourceRunId: source.id })},
          'pending', 0, ${at}, ${at}, ${at}
        )
      `;
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-older-queue"),
        threadId,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === queued!.id,
        )?.status,
        "starting",
      );
      yield* orchestrator.dispatch(
        stopType === "thread.stop"
          ? { type: "thread.stop", commandId: CommandId.make("stop-resumed-queue"), threadId }
          : {
              type: "run.interrupt",
              commandId: CommandId.make("stop-resumed-queue"),
              threadId,
              runId: queued!.id,
              holdQueue: true,
            },
      );
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      const interrupted = stopped.runs.find((run) => run.id === queued!.id)!;
      assert.equal(interrupted.status, "interrupted");
      assert.equal(DateTime.toEpochMillis(interrupted.completedAt!), DateTime.toEpochMillis(now));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("restart-after-stop"),
        threadId,
        messageId: MessageId.make("message:restart-after-stop"),
        text: "Continue.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        restartContinuationOfRunId: source.id,
      });
      assert.deepEqual(yield* threadState(threadId), {
        runs: ["completed", "cancelled", "interrupted"],
        watched: [],
      });
    }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect.each([
  { ending: "cancelled", question: "resolved" },
  { ending: "interrupted", question: "cancelled" },
  { ending: "completed", question: "pending" },
  { ending: "failed", question: "pending" },
] as const)(
  "a $ending delegated task leaves its async question $question",
  ({ ending, question }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parentThreadId = ThreadId.make(`thread:stop-question-parent:${ending}`);
      yield* createWatchingThread(parentThreadId, 20);
      yield* send(parentThreadId, "first", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, `question task ${ending}`);
      const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
      assert.equal(
        (yield* orchestrator.getThreadProjection(childThreadId)).nodes.find(
          (node) => node.id === childRun.rootNodeId,
        )?.runId,
        childRun.id,
      );
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:stop-question:request"),
        type: "runtime-request.updated",
        threadId: childThreadId,
        runId: childRun.id,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make("request:stop-question"),
          nodeId: childRun.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      });
      const request = Effect.map(
        orchestrator.getThreadProjection(childThreadId),
        (projection) => projection.runtimeRequests[0],
      );

      yield* orchestrator.recoverDelegatedTask(childThreadId, childRun.id);
      assert.equal((yield* request)?.status, "pending");
      if (ending === "interrupted") {
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-question-child"),
          threadId: childThreadId,
        });
      } else {
        yield* projections.apply({
          id: EventId.make(`event:stop-question:${ending}`),
          type: "run.updated",
          threadId: childThreadId,
          runId: childRun.id,
          occurredAt: now,
          payload: { ...childRun, status: ending, startedAt: now, completedAt: now },
        });
      }
      yield* orchestrator.recoverDelegatedTask(childThreadId, childRun.id);
      assert.equal((yield* request)?.status, question);
      assert.equal((yield* request)?.decision, question === "resolved" ? "cancel" : undefined);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a delegated task that cannot be stopped fails the walk after its siblings stop", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parentThreadId = ThreadId.make("thread:stop-partial");
    yield* createWatchingThread(parentThreadId, 6);
    yield* send(parentThreadId, "work", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "stoppable task");
    const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-partial:missing-task"),
      type: "subagent.updated",
      threadId: parentThreadId,
      runId: task.runId!,
      nodeId: NodeId.make("node:stop-partial:missing"),
      providerInstanceId: instanceId,
      occurredAt: yield* DateTime.now,
      payload: {
        ...task,
        id: NodeId.make("node:stop-partial:missing"),
        childThreadId: ThreadId.make("thread:stop-partial:missing"),
        startedAt: DateTime.subtract(task.startedAt!, { hours: 1 }),
      },
    });

    const walked = yield* Effect.exit(
      threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("stop-partial"),
      }),
    );
    assert.isTrue(Exit.isFailure(walked));
    assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop marks a turn it cannot interrupt so a late agent watch is refused", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-lost-session");
    yield* createWatchingThread(threadId, 11);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-lost-session:running"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now },
    });
    yield* projections.apply({
      id: EventId.make("event:stop-lost-session:turn"),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make("provider-turn:stop-lost-session"),
        providerThreadId: run.providerThreadId!,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId!,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-lost-session"),
      threadId,
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 12))));
    assert.deepEqual(yield* threadState(threadId), { runs: ["running"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["missing session", "completed", "failed", "cancelled"] as const)(
  "a native child Stop only settles a confirmed %s outcome and preserves its owner and sibling",
  (providerState) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:native-child-stop");
      yield* createWatchingThread(threadId, 20);
      yield* send(threadId, "owner", "start_immediately");
      yield* delegate(threadId, "native-child-fixture");
      const before = yield* orchestrator.getThreadProjection(threadId);
      const run = before.runs[0]!;
      const now = yield* DateTime.now;
      const subagent = {
        ...before.subagents[0]!,
        origin: "provider_native" as const,
        driver: CLAUDE_PROVIDER,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        nativeTaskRef: {
          driver: CLAUDE_PROVIDER,
          nativeId: "claude-task",
          strength: "strong" as const,
        },
        status: "running" as const,
        startedAt: now,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:agent"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: subagent.id,
        occurredAt: now,
        payload: subagent,
      });
      const sibling = {
        ...subagent,
        id: NodeId.make("node:native-stop-sibling"),
        childThreadId: null,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:sibling"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: sibling.id,
        occurredAt: now,
        payload: sibling,
      });
      const item = before.turnItems.find(
        (item) => item.type === "subagent" && item.subagentId === subagent.id,
      )!;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:item"),
        type: "turn-item.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...item, status: "running", completedAt: null },
      });
      const childRoot = {
        ...before.nodes.find((node) => node.id === run.rootNodeId)!,
        id: NodeId.make("node:native-stop-child-root"),
        threadId: subagent.childThreadId!,
        runId: null,
        parentNodeId: null,
        status: "running" as const,
        countsForRun: false,
        completedAt: null,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:child-root"),
        type: "node.updated",
        threadId: childRoot.threadId,
        nodeId: childRoot.id,
        occurredAt: now,
        payload: childRoot,
      });
      const childTurnId = ProviderTurnId.make("turn:native-stop-child");
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:child-turn"),
        type: "provider-turn.updated",
        threadId: childRoot.threadId,
        nodeId: childRoot.id,
        occurredAt: now,
        payload: {
          id: childTurnId,
          providerThreadId: ProviderThreadId.make("provider-thread:native-stop-child"),
          nodeId: childRoot.id,
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      });
      const providerThread = before.providerThreads.find(
        (thread) => thread.id === run.providerThreadId,
      )!;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...providerThread,
          driver: CLAUDE_PROVIDER,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          providerSessionId: ProviderSessionId.make("session:native-child-stop"),
        },
      });
      const providerTurnId = ProviderTurnId.make("turn:native-child-stop");
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:provider-turn"),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId: providerThread.id,
          nodeId: run.rootNodeId!,
          runAttemptId: run.activeAttemptId!,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:owner-completed"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", startedAt: now, completedAt: now },
      });
      yield* send(threadId, "queued", "queue_after_active");
      const stateBefore = yield* threadState(threadId);
      const eventStore = yield* EventStore.EventStoreV2;
      const afterSequence = yield* eventStore.latestSequence({ threadId });
      const confirmedStatus =
        providerState === "completed" || providerState === "failed" || providerState === "cancelled"
          ? providerState
          : null;
      const confirmedOutcome =
        confirmedStatus === null
          ? undefined
          : { status: confirmedStatus, completedAt: now, result: "Actual provider outcome" };
      const commandId = CommandId.make("stop-native-child");
      yield* orchestrator.dispatch({
        type: "subagent.stop",
        commandId,
        threadId,
        runId: run.id,
        subagentId: subagent.id,
      });
      assert.deepEqual(yield* threadState(threadId), stateBefore);
      const effects = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_effect_outbox WHERE command_id = ${commandId}
    `;
      assert.equal(effects.length, 1);
      assert.deepEqual(JSON.parse(effects[0]!.payload_json), {
        type: "provider-turn.interrupt",
        providerSessionId: "session:native-child-stop",
        providerThreadId: providerThread.id,
        providerTurnId,
        subagent: { id: subagent.id, nativeTaskId: "claude-task" },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents[0]?.status,
        "running",
      );
      const unrelated = yield* Effect.exit(
        orchestrator.dispatch({
          type: "subagent.stop",
          commandId: CommandId.make("stop-unknown-child"),
          threadId,
          runId: run.id,
          subagentId: NodeId.make("unknown-child"),
        }),
      );
      assert.isTrue(Exit.isFailure(unrelated));
      yield* TestClock.adjust("1 second");
      yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE command_id != ${commandId}`;
      if (providerState === "missing session") {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.drain();
      } else {
        yield* orchestrator.dispatch({
          type: "thread.background-work.settle",
          commandId: CommandId.make("repair-native-child"),
          threadId,
          providerThreadId: providerThread.id,
          providerTurnId,
          subagent: { id: subagent.id, stoppedAt: now, outcome: confirmedOutcome! },
        });
      }
      const settled = yield* orchestrator.getThreadProjection(threadId);
      const cancelled = settled.subagents.find((task) => task.id === subagent.id)!;
      if (confirmedOutcome === undefined) {
        const events = yield* eventStore.read({ threadId, afterSequence }).pipe(Stream.runCollect);
        assert.isFalse(
          events.some(
            ({ event }) =>
              (event.type === "subagent.updated" ||
                event.type === "node.updated" ||
                event.type === "turn-item.updated") &&
              ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status),
          ),
        );
        assert.equal(cancelled.status, "running");
        assert.equal(
          (yield* orchestrator.getThreadProjection(childRoot.threadId)).nodes.find(
            (node) => node.id === childRoot.id,
          )?.status,
          "running",
        );
        assert.deepEqual(yield* threadState(threadId), stateBefore);
        return;
      }

      const repaired = yield* eventStore.read({ threadId, afterSequence }).pipe(Stream.runCollect);
      const terminal = repaired.flatMap(({ event }) =>
        (event.type === "subagent.updated" ||
          event.type === "node.updated" ||
          event.type === "turn-item.updated") &&
        event.payload.status === confirmedStatus
          ? [event]
          : [],
      );
      assert.deepEqual(terminal.map((event) => event.type).sort(), [
        "node.updated",
        "subagent.updated",
        "turn-item.updated",
      ]);
      for (const event of terminal) {
        assert.equal(event.nodeId, subagent.id);
        assert.equal(
          DateTime.toEpochMillis(event.payload.completedAt!),
          DateTime.toEpochMillis(confirmedOutcome!.completedAt),
        );
        if (event.type === "subagent.updated" || event.type === "turn-item.updated") {
          assert.isDefined(event.payload.updatedAt);
        }
      }

      assert.equal(cancelled.status, confirmedStatus);
      assert.isNotNull(cancelled.completedAt);
      assert.equal(
        DateTime.toEpochMillis(cancelled.completedAt!),
        DateTime.toEpochMillis(confirmedOutcome!.completedAt),
      );
      assert.equal(cancelled.result, confirmedOutcome!.result);
      assert.equal(
        settled.turnItems.find((candidate) => candidate.id === item.id)?.status,
        confirmedStatus,
      );
      const child = yield* orchestrator.getThreadProjection(childRoot.threadId);
      assert.equal(child.nodes.find((node) => node.id === childRoot.id)?.status, confirmedStatus);
      assert.equal(
        child.providerTurns.find((turn) => turn.id === childTurnId)?.status,
        confirmedStatus,
      );
      assert.isNotNull(child.nodes.find((node) => node.id === childRoot.id)?.completedAt);
      assert.equal(settled.subagents.find((task) => task.id === sibling.id)?.status, "running");
      assert.deepEqual(yield* threadState(threadId), stateBefore);
      yield* TestClock.adjust("1 second");
      const resumedAt = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:resume"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: subagent.id,
        occurredAt: resumedAt,
        payload: { ...cancelled, status: "running", startedAt: resumedAt, completedAt: null },
      });
      yield* orchestrator.dispatch({
        type: "thread.background-work.settle",
        commandId: CommandId.make("old-stop-after-resume"),
        threadId,
        providerThreadId: providerThread.id,
        providerTurnId,
        subagent: { id: subagent.id, stoppedAt: now, outcome: confirmedOutcome },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.id === subagent.id,
        )?.status,
        "running",
      );
    }).pipe(Effect.provide(layerTest)),
);

const layerQuestionExecutor = EffectWorker.layerExecutor.pipe(
  Layer.provide(
    Layer.mergeAll(
      RuntimeRequestService.layer,
      Layer.mock(RunFinalizationService.RunFinalizationService)({}),
      Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({}),
      Layer.mock(ProviderTurnControlService.ProviderTurnControlServiceV2)({}),
      Layer.mock(ProviderTurnStartService.ProviderTurnStartServiceV2)({}),
      Layer.mock(ThreadTitleRegenerationService.ThreadTitleRegenerationService)({}),
    ),
  ),
);

const executeFailedAnswer = (commandId: CommandId) =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const effect = (yield* outbox.listByCommandId(commandId)).find(
      (effect) => effect.request.type === "runtime-request.respond",
    );
    if (effect === undefined) return yield* Effect.die("Missing durable answer delivery effect");
    const result = yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      return yield* Effect.exit(executor.execute(effect, { willRetry: false }));
    }).pipe(Effect.provide(layerQuestionExecutor));
    assert.isTrue(Exit.isFailure(result));
  });

const createPromptWaitingRun = (key: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const threadId = ThreadId.make(`thread:stop-prompts:${key}`);
    yield* createWatchingThread(threadId, 40);
    yield* send(threadId, "waiting for input", "start_immediately");
    const before = yield* orchestrator.getThreadProjection(threadId);
    const run = before.runs[0]!;
    const attempt = before.attempts[0]!;
    const providerThread = before.providerThreads[0]!;
    const providerSessionId = ProviderSessionId.make(`session:stop-prompts:${key}`);
    const providerTurnId = ProviderTurnId.make(`turn:stop-prompts:${key}`);
    yield* sessions.open({
      threadId,
      providerSessionId,
      modelSelection,
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      },
    });
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`${threadId}:provider-thread`),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: { ...providerThread, providerSessionId, status: "active", updatedAt: now },
    });
    yield* projections.apply({
      id: EventId.make(`${threadId}:run`),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now },
    });
    yield* projections.apply({
      id: EventId.make(`${threadId}:attempt`),
      type: "run-attempt.updated",
      threadId,
      occurredAt: now,
      payload: { ...attempt, providerTurnId, status: "running", startedAt: now },
    });
    yield* projections.apply({
      id: EventId.make(`${threadId}:provider-turn`),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerTurnId,
        providerThreadId: providerThread.id,
        nodeId: run.rootNodeId!,
        runAttemptId: attempt.id,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });
    for (const kind of ["user_input", "command"] as const) {
      const nodeId = NodeId.make(`${threadId}:node:${kind}`);
      const requestId = RuntimeRequestId.make(`${threadId}:request:${kind}`);
      yield* projections.apply({
        id: EventId.make(`${nodeId}:event`),
        type: "node.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId,
          runId: run.id,
          parentNodeId: run.rootNodeId,
          rootNodeId: run.rootNodeId!,
          kind: kind === "user_input" ? "user_input_request" : "approval_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: providerThread.id,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`${requestId}:event`),
        type: "runtime-request.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId,
          providerTurnId,
          nativeRequestRef: null,
          kind,
          status: "pending",
          responseCapability: { type: "live", providerSessionId },
          createdAt: now,
          resolvedAt: null,
        },
      });
      const baseItem = {
        id: TurnItemId.make(`${requestId}:item`),
        threadId,
        runId: run.id,
        nodeId,
        providerThreadId: providerThread.id,
        providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: kind === "user_input" ? 1 : 2,
        status: "waiting" as const,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        requestId,
      };
      yield* projections.apply({
        id: EventId.make(`${requestId}:item-event`),
        type: "turn-item.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload:
          kind === "user_input"
            ? {
                ...baseItem,
                type: "user_input_request",
                questions: [{ id: "answer", header: "Choice", question: "Which?", options: [] }],
              }
            : { ...baseItem, type: "approval_request", requestKind: "command" },
      });
    }
    assert.equal((yield* orchestrator.getThreadProjection(threadId)).runtimeRequests.length, 2);
    return {
      threadId,
      run,
      providerSessionId,
      providerTurnId,
      questionRequestId: RuntimeRequestId.make(`${threadId}:request:user_input`),
    };
  });

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "%s closes questions and approvals before the provider acknowledges Stop",
  (type) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, run } = yield* createPromptWaitingRun(type);
      const stop = { commandId: CommandId.make(`${threadId}:stop`), threadId };
      yield* orchestrator.dispatch(
        type === "run.interrupt"
          ? { ...stop, type, runId: run.id, holdQueue: true }
          : { ...stop, type },
      );
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        stopped.runtimeRequests.map((request) => request.status),
        ["cancelled", "cancelled"],
      );
      assert.isTrue(
        stopped.runtimeRequests.every(
          (request) => request.responseCapability.type === "not_resumable",
        ),
      );
      assert.deepEqual(
        stopped.nodes.filter((node) => node.runtimeRequestId !== null).map((node) => node.status),
        ["cancelled", "cancelled"],
      );
      assert.deepEqual(
        stopped.turnItems
          .filter((item) => item.type === "approval_request" || item.type === "user_input_request")
          .map((item) => item.status),
        ["cancelled", "cancelled"],
      );
      for (const request of stopped.runtimeRequests) {
        const late = yield* Effect.exit(
          orchestrator.dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make(`${request.id}:late`),
            threadId,
            requestId: request.id,
            decision: "accept",
            answers: { answer: "stale" },
          }),
        );
        assert.isTrue(Exit.isFailure(late));
      }
      assert.equal(
        stopped.runs[0]?.status,
        "running",
        "provider acknowledgement is deliberately still outstanding",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["live", "ended"] as const)(
  "reopens a failed answer with a %s provider and accepts a retry",
  (state) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const { threadId, questionRequestId, providerSessionId } = yield* createPromptWaitingRun(
        `reply:${state}`,
      );
      const answer = {
        type: "runtime-request.respond" as const,
        threadId,
        requestId: questionRequestId,
        commandId: CommandId.make(`${threadId}:answer:1`),
        answers: { answer: "first" },
      };
      yield* orchestrator.dispatch(answer);
      const submitted = (yield* orchestrator.getThreadProjection(threadId)).runtimeRequests.find(
        (request) => request.id === questionRequestId,
      )!;
      assert.equal(submitted.status, "resolved");
      if (state === "ended")
        yield* sessions.release({ providerSessionId, reason: "runtime_error" });
      const failure = {
        type: "runtime-request.response-failed" as const,
        threadId,
        requestId: questionRequestId,
        responseCommandId: answer.commandId,
        commandId: CommandId.make(`${threadId}:failure:1`),
      };
      yield* executeFailedAnswer(answer.commandId);
      const reopened = yield* orchestrator.getThreadProjection(threadId);
      const request = reopened.runtimeRequests.find((request) => request.id === questionRequestId)!;
      const item = reopened.turnItems.find(
        (item) => item.type === "user_input_request" && item.requestId === questionRequestId,
      )!;
      assert.equal(request.status, "pending");
      assert.equal(request.answers, undefined);
      assert.equal(request.responseCommandId, undefined);
      assert.equal(request.responseCapability.type, state === "live" ? "live" : "message");
      assert.equal(item.status, "waiting");
      assert.equal(item.type === "user_input_request" && item.questionAnswer, undefined);
      yield* orchestrator.dispatch({
        ...answer,
        commandId: CommandId.make(`${threadId}:answer:2`),
        answers: { answer: "second" },
      });
      // A delayed duplicate failure from the first answer cannot reopen the second.
      yield* orchestrator.dispatch({
        ...failure,
        commandId: CommandId.make(`${threadId}:failure:stale`),
      });
      const retried = yield* orchestrator.getThreadProjection(threadId);
      const retriedRequest = retried.runtimeRequests.find(
        (request) => request.id === questionRequestId,
      )!;
      assert.equal(retriedRequest.status, "resolved");
      assert.deepEqual(retriedRequest.answers, { answer: "second" });
      if (state === "ended") assert.equal(retried.messages.at(-1)?.text, "Which?\nsecond");
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "a failed submitted answer cannot reopen a question after %s",
  (type) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, run, questionRequestId } = yield* createPromptWaitingRun(
        `late-failure:${type}`,
      );
      const responseCommandId = CommandId.make(`${threadId}:answer`);
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: responseCommandId,
        threadId,
        requestId: questionRequestId,
        answers: { answer: "yes" },
      });
      const stop = { commandId: CommandId.make(`${threadId}:stop`), threadId };
      yield* orchestrator.dispatch(
        type === "thread.stop"
          ? { ...stop, type }
          : { ...stop, type, runId: run.id, holdQueue: true },
      );
      yield* executeFailedAnswer(responseCommandId);
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      assert.isFalse(stopped.runtimeRequests.some((request) => request.status === "pending"));
      assert.equal(
        stopped.runtimeRequests.find((request) => request.id === questionRequestId)?.status,
        "resolved",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["turn", "session"] as const)(
  "reopens as a message when the %s ends just before the failure commits",
  (ended) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const { threadId, questionRequestId, providerTurnId, providerSessionId } =
        yield* createPromptWaitingRun(`reply-race:${ended}`);
      const responseCommandId = CommandId.make(`${threadId}:answer`);
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: responseCommandId,
        threadId,
        requestId: questionRequestId,
        answers: { answer: "yes" },
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const commit = sink.commitCommand;
      let changed = false;
      const spy = vi.spyOn(sink, "commitCommand").mockImplementation((input) =>
        Effect.gen(function* () {
          if (!changed && input.commandType === "runtime-request.response-failed") {
            changed = true;
            const now = yield* DateTime.now;
            yield* sink.write({
              events: [
                ended === "turn"
                  ? {
                      id: EventId.make(`${threadId}:ended`),
                      type: "provider-turn.updated",
                      threadId,
                      occurredAt: now,
                      payload: {
                        ...before.providerTurns.find((turn) => turn.id === providerTurnId)!,
                        status: "completed",
                        completedAt: now,
                      },
                    }
                  : {
                      id: EventId.make(`${threadId}:ended`),
                      type: "provider-session.updated",
                      threadId,
                      occurredAt: now,
                      payload: {
                        ...before.providerSessions.find(
                          (session) => session.id === providerSessionId,
                        )!,
                        status: "stopped",
                        updatedAt: now,
                      },
                    },
              ],
            });
          }
          return yield* commit(input);
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      yield* executeFailedAnswer(responseCommandId);
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.isTrue(changed);
      assert.equal(
        after.runtimeRequests.find((request) => request.id === questionRequestId)
          ?.responseCapability.type,
        "message",
      );
      const question = after.turnItems.find(
        (item) => item.type === "user_input_request" && item.requestId === questionRequestId,
      );
      assert.equal(
        question?.type === "user_input_request" ? question.responseMode : undefined,
        "message",
      );
    }).pipe(Effect.provide(layerTest)),
);
