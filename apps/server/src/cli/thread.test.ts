import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { buildIsolatedThreadStart } from "./thread.ts";

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
    createdAt: "2026-09-26T00:00:00.000Z",
  });

  assert.equal(command.type, "thread.turn.start");
  assert.equal(command.bootstrap?.prepareWorktree?.projectCwd, "/repo");
  assert.equal(command.bootstrap?.prepareWorktree?.requireWorktree, true);
  assert.equal(command.bootstrap?.prepareWorktree?.branch, "t3code/12345678");
  assert.equal(command.bootstrap?.createThread?.worktreePath, null);
  assert.equal(command.bootstrap?.createThread?.projectId, "project-1");
  assert.equal(command.message.text, "Fix the billing bug");
});
