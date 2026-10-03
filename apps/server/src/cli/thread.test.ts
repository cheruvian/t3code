import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { buildIsolatedThreadStart, recentThreadMessages, isFinishedThread } from "./thread.ts";

it("starts an isolated worktree before the first provider turn", () => {
  const command = buildIsolatedThreadStart({
    project: { id: ProjectId.make("project-1"), workspaceRoot: "/repo" },
    title: "Fix billing",
    message: "Fix the billing bug",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-sol" },
    baseBranch: "main",
    branch: "t3code/12345678",
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    commandId: CommandId.make("command-1"),
  });

  assert.deepEqual(command.workspaceStrategy, {
    type: "worktree",
    baseRef: "main",
    branch: "t3code/12345678",
  });
  assert.equal(command.projectId, "project-1");
  assert.equal(command.initialMessage?.text, "Fix the billing bug");
});

it("retains every assistant message in a requested turn", () => {
  const messages = [
    { role: "user", text: "old" },
    { role: "assistant", text: "old answer" },
    { role: "user", text: "new" },
    { role: "assistant", text: "thinking" },
    { role: "assistant", text: "answer" },
  ] as const;
  assert.deepEqual(recentThreadMessages(messages, 1), {
    messages: messages.slice(2),
    hasMore: true,
  });
  assert.deepEqual(recentThreadMessages(messages, 10), { messages: [...messages], hasMore: false });
});

it("waits through preparation, queued runs and pending user input", () => {
  const latestRunId = "run-1" as Parameters<typeof isFinishedThread>[0]["latestRunId"];
  for (const status of ["preparing", "queued", "starting", "running", "waiting"] as const) {
    assert.equal(isFinishedThread({ latestRunId, status }), false);
  }
  for (const status of [
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "rolled_back",
  ] as const) {
    assert.equal(isFinishedThread({ latestRunId, status }), true);
  }
  assert.equal(isFinishedThread({ latestRunId: null, status: "idle" }), false);
});
