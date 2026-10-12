import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { getWorktreeCleanupOwners } from "./worktreeOwnership";

function subagent(id: string, parentId: string) {
  return {
    id: ThreadId.make(id),
    lineage: {
      rootThreadId: ThreadId.make("root"),
      parentThreadId: ThreadId.make(parentId),
      relationshipToParent: "subagent" as const,
    },
  };
}

describe("worktree cleanup ownership", () => {
  it("ignores idle child references after their parent conversation is deleted", () => {
    expect(
      getWorktreeCleanupOwners([subagent("reviewer", "root")], ThreadId.make("root"), () => true),
    ).toEqual([]);
  });

  it("retains a reference when its intermediate parent is unknown", () => {
    const reviewer = subagent("reviewer", "missing-parent");
    expect(getWorktreeCleanupOwners([reviewer], ThreadId.make("root"), () => true)).toEqual([
      reviewer,
    ]);
  });

  it("retains cyclic lineage references without treating them as owned descendants", () => {
    const reviewers = [subagent("reviewer-a", "reviewer-b"), subagent("reviewer-b", "reviewer-a")];
    expect(getWorktreeCleanupOwners(reviewers, ThreadId.make("root"), () => true)).toEqual(
      reviewers,
    );
  });
});
