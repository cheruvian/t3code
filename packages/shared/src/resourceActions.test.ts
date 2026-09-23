import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  EventId,
  ThreadId,
  type OrchestrationThreadActivity,
  type ProjectResourceLock,
} from "@t3tools/contracts";
import {
  resourceActionLogs,
  formatResourceActionLog,
  threadResourceColor,
} from "./resourceActions.ts";

describe("resource action presentation", () => {
  it("keeps the final result per operation and reports truncation", () => {
    const log = {
      operationId: CommandId.make("op"),
      resourceName: "Sandbox",
      action: "checkout" as const,
      command: "deploy",
      stdout: "done",
      stderr: "warning",
      truncated: true,
    };
    const activity = (status: "running" | "succeeded"): OrchestrationThreadActivity => ({
      id: EventId.make(status),
      tone: "info",
      kind: "resource.action",
      summary: status,
      payload: { ...log, status },
      turnId: null,
      createdAt: "2026-09-22T00:00:00Z",
    });
    const logs = resourceActionLogs([
      activity("running"),
      activity("succeeded"),
      activity("running"),
      { ...activity("running"), payload: null },
    ]);
    expect(logs).toEqual([{ ...log, status: "succeeded" }]);
    expect(formatResourceActionLog(logs[0]!)).toContain("showing the latest output");
    expect(formatResourceActionLog(logs[0]!)).toContain("stderr:\nwarning");
  });
  it("marks only the owning thread, including failed reservations", () => {
    const lock: ProjectResourceLock = {
      threadId: ThreadId.make("owner"),
      operationId: CommandId.make("op"),
      phase: "failed",
      script: {
        id: "sandbox",
        name: "Sandbox",
        command: "deploy",
        icon: "play",
        runOnWorktreeCreate: false,
        resource: { color: "#abcdef", checkoutPrompt: "", releaseCommand: "", releasePrompt: "" },
      },
    };
    expect(threadResourceColor([lock], ThreadId.make("owner"))).toBe("#abcdef");
    expect(threadResourceColor([lock], ThreadId.make("other"))).toBeUndefined();
    expect(threadResourceColor([], ThreadId.make("owner"))).toBeUndefined();
  });
});
