import {
  EnvironmentId,
  type OrchestrationV2AssistantMessageItem,
  NodeId,
  ProviderDriverKind,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  ThreadId,
  RunId,
  MessageId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection, v2Now } from "./orchestrationV2TestFixtures.ts";
import { EMPTY_THREAD_HISTORY_META } from "./threadHistoryMerge.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import type { EnvironmentThreadState } from "./threads.ts";

const ref: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-detail"),
  threadId: ThreadId.make(v2Projection.thread.id),
};

function threadState(
  partial: Pick<EnvironmentThreadState, "data" | "status" | "error"> &
    Partial<Pick<EnvironmentThreadState, "history">>,
): EnvironmentThreadState {
  return { ...partial, history: partial.history ?? EMPTY_THREAD_HISTORY_META };
}

describe("createEnvironmentThreadDetailAtoms", () => {
  it("adds environment scope while preserving the pristine projection", () => {
    const initial: AsyncResult.AsyncResult<EnvironmentThreadState, never> = AsyncResult.success(
      threadState({
        data: Option.some(v2Projection),
        status: "cached",
        error: Option.none(),
      }),
    );
    const sourceAtom = Atom.make(initial);
    const details = createEnvironmentThreadDetailAtoms(() => sourceAtom);
    const registry = AtomRegistry.make();

    const thread = registry.get(details.threadAtom(ref));
    expect(thread).toEqual({ environmentId: ref.environmentId, projection: v2Projection });
    expect(thread?.projection).toBe(v2Projection);
    expect(registry.get(details.visibleTurnItemsAtom(ref))).toBe(v2Projection.visibleTurnItems);
    expect(registry.get(details.statusAtom(ref))).toBe("cached");
    expect(registry.get(details.historyAtom(ref))).toBe(EMPTY_THREAD_HISTORY_META);

    registry.set(
      sourceAtom,
      AsyncResult.success(
        threadState({
          data: Option.some(v2Projection),
          status: "synchronizing",
          error: Option.none(),
        }),
      ),
    );

    expect(registry.get(details.threadAtom(ref))).toBe(thread);
    expect(registry.get(details.statusAtom(ref))).toBe("synchronizing");

    const progressiveHistory = {
      ...EMPTY_THREAD_HISTORY_META,
      historyCursor: "cursor-1",
      hasMoreHistory: true,
    };
    registry.set(
      sourceAtom,
      AsyncResult.success(
        threadState({
          data: Option.some(v2Projection),
          status: "live",
          error: Option.some("Stream interrupted."),
          history: progressiveHistory,
        }),
      ),
    );

    expect(registry.get(details.threadAtom(ref))).toBe(thread);
    expect(registry.get(details.visibleTurnItemsAtom(ref))).toBe(v2Projection.visibleTurnItems);
    expect(registry.get(details.statusAtom(ref))).toBe("live");
    expect(registry.get(details.errorAtom(ref))).toBe("Stream interrupted.");
    expect(registry.get(details.historyAtom(ref))).toBe(progressiveHistory);

    registry.set(
      sourceAtom,
      AsyncResult.success(
        threadState({
          data: Option.none(),
          status: "deleted",
          error: Option.none(),
        }),
      ),
    );

    expect(registry.get(details.threadAtom(ref))).toBeNull();
    expect(registry.get(details.visibleTurnItemsAtom(ref))).toEqual([]);
    expect(registry.get(details.statusAtom(ref))).toBe("deleted");
    expect(registry.get(details.errorAtom(ref))).toBeNull();
    expect(registry.get(details.historyAtom(ref))).toBe(EMPTY_THREAD_HISTORY_META);
    registry.dispose();
  });
});

it("does not notify queue consumers for streaming text or execution nodes", () => {
  const projection = {
    ...v2Projection,
    runs: [
      {
        id: RunId.make("queued-run"),
        threadId: v2Projection.thread.id,
        ordinal: 1,
        providerInstanceId: v2Projection.thread.providerInstanceId,
        modelSelection: v2Projection.thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("queued-message"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued" as const,
        requestedAt: v2Now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
  };
  const source = Atom.make(
    AsyncResult.success(
      threadState({ data: Option.some(projection), status: "live", error: Option.none() }),
    ),
  );
  const details = createEnvironmentThreadDetailAtoms(() => source);
  const registry = AtomRegistry.make();
  const dispose = registry.mount(details.queueWorkflowAtom(ref));
  const before = registry.get(details.queueWorkflowAtom(ref));
  const disposeCount = registry.mount(details.queuedCountAtom(ref));
  expect(registry.get(details.queuedCountAtom(ref))).toBe(1);
  registry.set(
    source,
    AsyncResult.success(
      threadState({
        data: Option.some({
          ...projection,
          nodes: [...v2Projection.nodes],
          turnItems: [...v2Projection.turnItems],
        }),
        status: "live",
        error: Option.none(),
      }),
    ),
  );
  expect(registry.get(details.queueWorkflowAtom(ref))).toBe(before);
  expect(registry.get(details.queuedCountAtom(ref))).toBe(1);
  registry.set(
    source,
    AsyncResult.success(
      threadState({ data: Option.none(), status: "deleted", error: Option.none() }),
    ),
  );
  expect(registry.get(details.queueWorkflowAtom(ref))).toBeNull();
  expect(registry.get(details.queuedCountAtom(ref))).toBe(0);
  disposeCount();
  dispose();
  registry.dispose();
});

it("does not notify the agents pill for unrelated projection updates", () => {
  const projection: OrchestrationV2ThreadProjection = {
    ...v2Projection,
    runs: [
      {
        id: RunId.make("active-run"),
        threadId: v2Projection.thread.id,
        ordinal: 1,
        providerInstanceId: v2Projection.thread.providerInstanceId,
        modelSelection: v2Projection.thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: v2Now,
        startedAt: v2Now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    subagents: [
      {
        id: NodeId.make("subagent-1"),
        threadId: v2Projection.thread.id,
        runId: RunId.make("active-run"),
        parentNodeId: NodeId.make("root"),
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: v2Projection.thread.providerInstanceId,
        providerThreadId: null,
        childThreadId: ThreadId.make("thread-child"),
        nativeTaskRef: null,
        prompt: "Do the thing",
        title: "Worker",
        model: null,
        status: "running",
        result: null,
        startedAt: v2Now,
        completedAt: null,
        updatedAt: v2Now,
      },
    ],
  };
  const source = Atom.make(
    AsyncResult.success(
      threadState({ data: Option.some(projection), status: "live", error: Option.none() }),
    ),
  );
  const details = createEnvironmentThreadDetailAtoms(() => source);
  const registry = AtomRegistry.make();
  const dispose = registry.mount(details.turnSubagentsAtom(ref));
  const before = registry.get(details.turnSubagentsAtom(ref));
  expect(before?.liveCount).toBe(1);
  registry.set(
    source,
    AsyncResult.success(
      threadState({
        data: Option.some({ ...projection, turnItems: [...v2Projection.turnItems] }),
        status: "live",
        error: Option.none(),
      }),
    ),
  );
  expect(registry.get(details.turnSubagentsAtom(ref))).toBe(before);
  dispose();
  registry.dispose();
});

it("keeps worktree and pending requests stable during output updates, then reflects resolution", () => {
  const projection: OrchestrationV2ThreadProjection = {
    ...v2Projection,
    thread: { ...v2Projection.thread, worktreePath: "/workspace/task" },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("approval"),
        nodeId: NodeId.make("approval-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "Provider exited" },
        createdAt: v2Now,
        resolvedAt: null,
      },
    ],
  };
  const source = Atom.make(
    AsyncResult.success(
      threadState({ data: Option.some(projection), status: "live", error: Option.none() }),
    ),
  );
  const details = createEnvironmentThreadDetailAtoms(() => source);
  const registry = AtomRegistry.make();
  const dispose = registry.mount(details.pendingRequestsAtom(ref));
  const before = registry.get(details.pendingRequestsAtom(ref));
  expect(before?.approvals).toHaveLength(1);
  const streaming: OrchestrationV2ThreadProjection = {
    ...projection,
    turnItems: [
      {
        id: TurnItemId.make("output"),
        threadId: projection.thread.id,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: null,
        startedAt: v2Now,
        completedAt: null,
        updatedAt: v2Now,
        type: "command_execution",
        input: "pwd",
        output: "new output",
        exitCode: undefined,
      },
    ],
  };
  registry.set(
    source,
    AsyncResult.success(
      threadState({ data: Option.some(streaming), status: "live", error: Option.none() }),
    ),
  );
  expect(registry.get(details.pendingRequestsAtom(ref))).toBe(before);
  expect(registry.get(details.worktreePathAtom(ref))).toBe("/workspace/task");
  registry.set(
    source,
    AsyncResult.success(
      threadState({
        data: Option.some({
          ...streaming,
          thread: { ...projection.thread, worktreePath: "/workspace/moved" },
          runtimeRequests: projection.runtimeRequests.map((request) => ({
            ...request,
            status: "resolved",
            resolvedAt: v2Now,
          })),
        }),
        status: "live",
        error: Option.none(),
      }),
    ),
  );
  expect(registry.get(details.pendingRequestsAtom(ref))?.approvals).toEqual([]);
  expect(registry.get(details.worktreePathAtom(ref))).toBe("/workspace/moved");
  dispose();
  registry.dispose();
});

it("shows an early reply in the shared timeline while keeping the durable projection pristine", () => {
  const item: OrchestrationV2AssistantMessageItem = {
    id: TurnItemId.make("early-reply"),
    threadId: ref.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: v2Now,
    type: "assistant_message",
    messageId: MessageId.make("early-message"),
    text: "Early reply",
    streaming: true,
  };
  const initial: EnvironmentThreadState = {
    data: Option.some(v2Projection),
    status: "live",
    error: Option.none(),
    history: EMPTY_THREAD_HISTORY_META,
    assistantPreviews: [item],
  };
  const source = Atom.make(AsyncResult.success(initial));
  const details = createEnvironmentThreadDetailAtoms(() => source);
  const registry = AtomRegistry.make();
  const stop = registry.mount(details.visibleTurnItemsAtom(ref));
  expect(registry.get(details.visibleTurnItemsAtom(ref)).at(-1)?.item).toEqual(item);
  expect(registry.get(details.threadAtom(ref))?.projection.turnItems.at(-1)).toEqual(item);
  expect(Option.getOrThrow(initial.data)).toBe(v2Projection);
  registry.set(source, AsyncResult.success({ ...initial, assistantPreviews: [] }));
  expect(registry.get(details.visibleTurnItemsAtom(ref))).toBe(v2Projection.visibleTurnItems);
  stop();
  registry.dispose();
});

it("places a provider preview after the persisted prompt and earlier reply", () => {
  const preview: OrchestrationV2AssistantMessageItem = {
    id: TurnItemId.make("preview-after-prompt"),
    threadId: ref.threadId,
    runId: RunId.make("preview-run"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 2,
    status: "running",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: v2Now,
    type: "assistant_message",
    messageId: MessageId.make("preview-message"),
    text: "New reply preview",
    streaming: true,
  };
  const prompt = {
    ...preview,
    id: TurnItemId.make("prompt"),
    messageId: MessageId.make("prompt-message"),
    type: "user_message" as const,
    ordinal: 26_000_001,
    text: "The triggering prompt",
    createdBy: "user" as const,
    creationSource: "web" as const,
    inputIntent: "turn_start" as const,
    attachments: [],
  };
  const earlier = {
    ...preview,
    id: TurnItemId.make("earlier-reply"),
    messageId: MessageId.make("earlier-message"),
    ordinal: 26_000_002,
    text: "An earlier completed reply",
    streaming: false,
    status: "completed" as const,
  };
  const projection = {
    ...v2Projection,
    turnItems: [prompt, earlier],
    visibleTurnItems: [prompt, earlier].map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: ref.threadId,
      sourceItemId: item.id,
      item,
    })),
  };
  const source = Atom.make(
    AsyncResult.success({
      data: Option.some(projection),
      status: "live" as const,
      error: Option.none(),
      history: EMPTY_THREAD_HISTORY_META,
      assistantPreviews: [preview],
    }),
  );
  const details = createEnvironmentThreadDetailAtoms(() => source);
  const registry = AtomRegistry.make();
  try {
    expect(registry.get(details.visibleTurnItemsAtom(ref)).map((row) => row.item.id)).toEqual([
      prompt.id,
      earlier.id,
      preview.id,
    ]);
    expect(projection.turnItems).toEqual([prompt, earlier]);
  } finally {
    registry.dispose();
  }
});
