import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import { makeThreadFixture } from "./test-fixtures";
import { getOrphanedWorktreePathForThread } from "./worktreeCleanup";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("getOrphanedWorktreePathForThread", () => {
  const worktreePath = "/tmp/repo/worktrees/feature-a";
  function reviewer(overrides: Partial<Thread> = {}) {
    return makeThread({
      id: ThreadId.make("reviewer"),
      worktreePath,
      lineage: {
        rootThreadId: ThreadId.make("thread-1"),
        parentThreadId: ThreadId.make("thread-1"),
        relationshipToParent: "subagent",
      },
      ...overrides,
    });
  }

  it("allows a parent to remove its worktree after an idle review subagent finishes", () => {
    expect(
      getOrphanedWorktreePathForThread(
        [makeThread({ worktreePath }), reviewer()],
        ThreadId.make("thread-1"),
      ),
    ).toBe(worktreePath);
  });

  it("includes idle nested subagents in their parent's cleanup", () => {
    expect(
      getOrphanedWorktreePathForThread(
        [
          makeThread({ worktreePath }),
          reviewer(),
          reviewer({
            id: ThreadId.make("nested-reviewer"),
            lineage: {
              rootThreadId: ThreadId.make("thread-1"),
              parentThreadId: ThreadId.make("reviewer"),
              relationshipToParent: "subagent",
            },
          }),
        ],
        ThreadId.make("thread-1"),
      ),
    ).toBe(worktreePath);
  });

  it.each(["running", "queued", "waiting"] as const)(
    "keeps the worktree while its subagent is %s",
    (status) => {
      const child = reviewer({
        runtime: {
          status,
          activeRunId: RunId.make("review-run"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: null,
          lastError: null,
          updatedAt: "2026-02-13T00:00:00.000Z",
        },
      });
      expect(
        getOrphanedWorktreePathForThread(
          [makeThread({ worktreePath }), child],
          ThreadId.make("thread-1"),
        ),
      ).toBeNull();
    },
  );

  it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
    "keeps a subagent's workspace while %s",
    (flag) => {
      expect(
        getOrphanedWorktreePathForThread(
          [makeThread({ worktreePath }), reviewer({ [flag]: true })],
          ThreadId.make("thread-1"),
        ),
      ).toBeNull();
    },
  );

  it("keeps a worktree shared with a forked conversation", () => {
    expect(
      getOrphanedWorktreePathForThread(
        [
          makeThread({ worktreePath }),
          reviewer({
            lineage: {
              rootThreadId: ThreadId.make("thread-1"),
              parentThreadId: ThreadId.make("thread-1"),
              relationshipToParent: "fork",
            },
          }),
        ],
        ThreadId.make("thread-1"),
      ),
    ).toBeNull();
  });

  it("keeps a worktree referenced by an unrelated subagent", () => {
    expect(
      getOrphanedWorktreePathForThread(
        [
          makeThread({ worktreePath }),
          reviewer({
            lineage: {
              rootThreadId: ThreadId.make("other-parent"),
              parentThreadId: ThreadId.make("other-parent"),
              relationshipToParent: "subagent",
            },
          }),
        ],
        ThreadId.make("thread-1"),
      ),
    ).toBeNull();
  });

  it("returns null when the target thread does not exist", () => {
    const result = getOrphanedWorktreePathForThread([], ThreadId.make("missing-thread"));
    expect(result).toBeNull();
  });

  it("returns null when the target thread has no worktree", () => {
    const threads = [makeThread()];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBeNull();
  });

  it("returns the path when no other thread links to that worktree", () => {
    const threads = [makeThread({ worktreePath: "/tmp/repo/worktrees/feature-a" })];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });

  it("returns null when another thread links to the same worktree", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBeNull();
  });

  it("ignores threads linked to different worktrees", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-b",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });
});
