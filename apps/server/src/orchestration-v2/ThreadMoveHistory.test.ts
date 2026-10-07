import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { rehomeThreadMoveHistory } from "./ThreadMoveHistory.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

describe("rehomeThreadMoveHistory", () => {
  it("removes source ownership and terminalizes live records", () => {
    const occurredAt = DateTime.makeUnsafe("2026-10-05T12:00:00.000Z");
    const threadId = ThreadId.make("thread:move-history");
    const sourceInstanceId = ProviderInstanceId.make("codex-source");
    const destinationInstanceId = ProviderInstanceId.make("codex-destination");
    const providerThreadId = ProviderThreadId.make("provider-thread:move-history");
    const driver = ProviderDriverKind.make("codex");
    const providerSessionId = ProviderSessionId.make("provider-session:move-history");
    const runId = RunId.make("run:move-history");
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      {
        id: EventId.make("event:move-history-session"),
        type: "provider-session.attached",
        threadId,
        occurredAt,
        payload: {
          id: providerSessionId,
          driver,
          providerInstanceId: sourceInstanceId,
          status: "running",
          cwd: "/source/worktree",
          model: "gpt-6",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: occurredAt,
          updatedAt: occurredAt,
          lastError: null,
        },
      },
      {
        id: EventId.make("event:move-history-run"),
        type: "run.updated",
        threadId,
        runId,
        providerInstanceId: sourceInstanceId,
        occurredAt,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: sourceInstanceId,
          modelSelection: { instanceId: sourceInstanceId, model: "gpt-6" },
          providerThreadId,
          userMessageId: MessageId.make("message:move-history"),
          rootNodeId: NodeId.make("node:move-history"),
          activeAttemptId: RunAttemptId.make("attempt:move-history"),
          status: "running",
          queuePosition: null,
          requestedAt: occurredAt,
          startedAt: occurredAt,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    ];

    const [session, run] = rehomeThreadMoveHistory(events, {
      moveId: "move-history",
      projectId: ProjectId.make("project:destination"),
      instanceId: destinationInstanceId,
      sourceInstanceId,
      cwd: "/destination/worktree",
      branch: "moved-thread",
      providerThread: {
        id: providerThreadId,
        driver,
        providerInstanceId: destinationInstanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-id", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        nativeMetadata: { itemIdentityVersion: 2 },
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
    });

    const historical = rehomeThreadMoveHistory(events, {
      moveId: "other-provider-history",
      projectId: ProjectId.make("project:destination"),
      sourceInstanceId: ProviderInstanceId.make("claude-source"),
      instanceId: ProviderInstanceId.make("claude-destination"),
      cwd: "/destination/worktree",
      branch: "moved-thread",
      providerThread: {
        id: providerThreadId,
        driver,
        providerInstanceId: destinationInstanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-id", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        nativeMetadata: null,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
    });
    const oldRun = historical.find((event) => event.type === "run.updated");
    if (oldRun?.type !== "run.updated") throw new Error("missing historical run");
    expect(oldRun.payload.providerInstanceId).toBe(sourceInstanceId);
    expect(oldRun.payload.modelSelection.instanceId).toBe(sourceInstanceId);
    expect(session?.type).toBe("provider-session.attached");
    if (session?.type !== "provider-session.attached") throw new Error("missing session");
    expect(session.payload.status).toBe("stopped");
    expect(session.payload.cwd).toBe("/destination/worktree");
    expect(session.payload.providerInstanceId).toBe(destinationInstanceId);
    expect(run?.type).toBe("run.updated");
    if (run?.type !== "run.updated") throw new Error("missing run");
    expect(run.payload.status).toBe("interrupted");
    expect(run.payload.activeAttemptId).toBeNull();
    expect(run.payload.providerInstanceId).toBe(destinationInstanceId);
    expect(run.payload.modelSelection.instanceId).toBe(destinationInstanceId);
  });
});
