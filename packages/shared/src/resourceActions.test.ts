import { describe, expect, it } from "vite-plus/test";
import { CommandId, ThreadId, type ProjectResourceLock } from "@t3tools/contracts";
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
    const activity = (status: "running" | "succeeded") => ({
      type: "command_execution",
      resourceActionLog: { ...log, status },
    });
    const logs = resourceActionLogs([
      activity("running"),
      activity("succeeded"),
      activity("running"),
      { ...activity("running"), resourceActionLog: null },
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
