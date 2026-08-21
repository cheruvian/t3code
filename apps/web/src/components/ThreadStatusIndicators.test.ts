import { effectiveSettled } from "@t3tools/client-runtime/state/thread-settled";
import type { OrchestrationThreadShell } from "@t3tools/contracts";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type VcsStatusAccumulatedResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  mergeThreadPrLifecycleSnapshot,
  nextThreadChangeRequestSnapshot,
  prStatusIndicator,
  resolveDisplayedThreadPr,
  resolveDisplayedThreadPrProvider,
  resolveThreadPr,
  resolveThreadPrLifecycleState,
  resolveVisibleVcsStatusTarget,
  settledPrHoverColorClass,
  threadChangeRequestSnapshotsAtom,
  threadPrLifecycleSnapshot,
  threadPrLifecycleTargetKey,
  type ThreadChangeRequestSnapshot,
  type ThreadPrLifecycleSnapshot,
} from "./ThreadStatusIndicators";

const environmentId = EnvironmentId.make("env-1");
const targetKeyA = threadPrLifecycleTargetKey({ environmentId, cwd: "/repo-a" });
const targetKeyB = threadPrLifecycleTargetKey({ environmentId, cwd: "/repo-b" });
if (targetKeyA === null || targetKeyB === null) throw new Error("Expected lifecycle target keys");

function status(overrides: Partial<VcsStatusAccumulatedResult> = {}): VcsStatusAccumulatedResult {
  return {
    isRepo: true,
    remoteStatusKnown: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/current",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: {
      number: 42,
      title: "PR branch",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      baseRef: "main",
      headRef: "feature/current",
      state: "open",
    },
    ...overrides,
  };
}

function mergedFeaturePr(): NonNullable<VcsStatusResult["pr"]> {
  return {
    number: 42,
    title: "Feature PR",
    url: "https://github.com/pingdotgg/t3code/pull/42",
    baseRef: "main",
    headRef: "feature/current",
    state: "merged",
  };
}

function snapshotFor(
  branch: string,
  pr: NonNullable<VcsStatusResult["pr"]>,
  sourceControlProvider?: VcsStatusResult["sourceControlProvider"],
): ThreadChangeRequestSnapshot {
  return { branch, pr, sourceControlProvider };
}

describe("resolveThreadPr", () => {
  it("keeps local-checkout PR indicators scoped to the stored thread branch", () => {
    expect(
      resolveThreadPr({
        threadBranch: "feature/other",
        gitStatus: status(),
      }),
    ).toBeUndefined();
  });

  it("hides PR indicators when a dedicated worktree has switched away from the thread branch", () => {
    expect(
      resolveThreadPr({
        threadBranch: "stack/base",
        gitStatus: status(),
      }),
    ).toBeUndefined();
  });

  it("hides PR indicators when thread branch metadata is missing", () => {
    expect(
      resolveThreadPr({
        threadBranch: null,
        gitStatus: status(),
      }),
    ).toBeNull();
  });

  it("shows the PR when the live checkout matches the stored thread branch", () => {
    const gitStatus = status();

    expect(
      resolveThreadPr({
        threadBranch: "feature/current",
        gitStatus,
      }),
    ).toBe(gitStatus.pr);
  });
});

describe("resolveDisplayedThreadPr + nextThreadChangeRequestSnapshot", () => {
  const featureBranch = "feature/current";
  const mergedPr = mergedFeaturePr();
  const provider = {
    kind: "github" as const,
    name: "GitHub",
    baseUrl: "https://github.com",
  };

  it("returns the live merged PR when the checkout matches the feature branch", () => {
    const gitStatus = status({
      refName: featureBranch,
      pr: mergedPr,
      sourceControlProvider: provider,
    });

    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus,
        snapshot: undefined,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBe(mergedPr);
    expect(
      resolveDisplayedThreadPrProvider({
        threadBranch: featureBranch,
        gitStatus,
        snapshot: undefined,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(provider);
  });

  it("after caching a merged PR, resolves main status back to the cached feature PR", () => {
    const matchingStatus = status({
      refName: featureBranch,
      pr: mergedPr,
      sourceControlProvider: provider,
    });
    const cached = nextThreadChangeRequestSnapshot({
      threadBranch: featureBranch,
      gitStatus: matchingStatus,
      snapshot: undefined,
      retainTerminalOnBranchMismatch: true,
    });
    expect(cached).toEqual(snapshotFor(featureBranch, mergedPr, provider));

    const mainStatus = status({
      refName: "main",
      isDefaultRef: true,
      pr: {
        number: 99,
        title: "Unrelated main PR",
        url: "https://github.com/pingdotgg/t3code/pull/99",
        baseRef: "main",
        headRef: "main",
        state: "open",
      },
      sourceControlProvider: provider,
    });

    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: mainStatus,
        snapshot: cached as ThreadChangeRequestSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(mergedPr);
    expect(
      resolveDisplayedThreadPrProvider({
        threadBranch: featureBranch,
        gitStatus: mainStatus,
        snapshot: cached as ThreadChangeRequestSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(provider);
  });

  it("never attaches a PR reported by main to the feature thread", () => {
    const mainPr = {
      number: 99,
      title: "Unrelated main PR",
      url: "https://github.com/pingdotgg/t3code/pull/99",
      baseRef: "develop",
      headRef: "main",
      state: "merged" as const,
    };
    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: mainPr }),
        snapshot: undefined,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: mainPr }),
        snapshot: undefined,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
  });

  it("does not show a cached open PR across a branch mismatch", () => {
    const openSnapshot = snapshotFor(featureBranch, {
      ...mergedPr,
      state: "open",
      title: "Still open",
    });

    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: openSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
  });

  it("retains a cached closed PR across a branch mismatch", () => {
    const closedPr = { ...mergedPr, state: "closed" as const, title: "Closed feature" };
    const closedSnapshot = snapshotFor(featureBranch, closedPr, provider);

    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: closedSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(closedPr);
  });

  it("does not retain or display a terminal PR when a worktree switches branches", () => {
    const terminalSnapshot = snapshotFor(featureBranch, mergedPr, provider);
    const mismatchedStatus = status({ refName: "feature/other", pr: null });

    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: mismatchedStatus,
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: false,
      }),
    ).toBeNull();
    expect(
      resolveDisplayedThreadPrProvider({
        threadBranch: featureBranch,
        gitStatus: mismatchedStatus,
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: false,
      }),
    ).toBeUndefined();
    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: featureBranch,
        gitStatus: mismatchedStatus,
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: false,
      }),
    ).toBeNull();
  });

  it("retains a local terminal snapshot when thread metadata follows the new branch", () => {
    const otherBranchSnapshot = snapshotFor("feature/other", mergedPr, provider);

    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: otherBranchSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(mergedPr);
  });

  it("retains a terminal snapshot when a local thread and status move to a branch with no PR", () => {
    const terminalSnapshot = snapshotFor(featureBranch, mergedPr, provider);

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: "main",
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeUndefined();
    expect(
      resolveDisplayedThreadPr({
        threadBranch: "main",
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(mergedPr);
  });

  it("clears an open snapshot when a local thread moves to a branch with no PR", () => {
    const openSnapshot = snapshotFor(featureBranch, { ...mergedPr, state: "open" });

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: "main",
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: openSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
  });

  it("clears an open snapshot when a local checkout moves to a different branch", () => {
    const openSnapshot = snapshotFor(featureBranch, { ...mergedPr, state: "open" });

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: openSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
  });

  it("clears a retained snapshot when the thread branch is cleared", () => {
    const terminalSnapshot = snapshotFor(featureBranch, mergedPr, provider);

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: null,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
    expect(
      resolveDisplayedThreadPr({
        threadBranch: null,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeNull();
    expect(
      resolveDisplayedThreadPrProvider({
        threadBranch: null,
        gitStatus: status({ refName: "main", pr: null }),
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeUndefined();
  });

  it("does not erase a terminal snapshot when VCS data is missing", () => {
    const terminalSnapshot = snapshotFor(featureBranch, mergedPr, provider);

    expect(
      nextThreadChangeRequestSnapshot({
        threadBranch: featureBranch,
        gitStatus: null,
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toBeUndefined();
    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: null,
        snapshot: terminalSnapshot,
        retainTerminalOnBranchMismatch: true,
      }),
    ).toEqual(mergedPr);
  });

  it("keeps effectiveSettled true for a retained merged PR after a main checkout", () => {
    const matchingStatus = status({
      refName: featureBranch,
      pr: mergedPr,
      sourceControlProvider: provider,
    });
    const cached = nextThreadChangeRequestSnapshot({
      threadBranch: featureBranch,
      gitStatus: matchingStatus,
      snapshot: undefined,
      retainTerminalOnBranchMismatch: true,
    });
    expect(cached).not.toBeNull();
    expect(cached).not.toBeUndefined();

    const mainStatus = status({ refName: "main", pr: null, isDefaultRef: true });
    const displayed = resolveDisplayedThreadPr({
      threadBranch: "main",
      gitStatus: mainStatus,
      snapshot: cached as ThreadChangeRequestSnapshot,
      retainTerminalOnBranchMismatch: true,
    });
    expect(displayed?.state).toBe("merged");

    const shell = {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Feature thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      latestTurn: null,
      session: null,
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z",
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      latestUserMessageAt: "2026-04-09T00:00:00.000Z",
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    } as OrchestrationThreadShell;

    expect(
      effectiveSettled(shell, {
        now: "2026-04-10T00:00:00.000Z",
        autoSettleAfterDays: null,
        changeRequest: displayed,
      }),
    ).toBe(true);
  });
});

describe("threadChangeRequestSnapshotsAtom", () => {
  it.effect("retains snapshots while sidebar and chat consumers are unmounted", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const threadKey = "environment-1:thread-1";
      const snapshot = snapshotFor("feature/current", mergedFeaturePr());

      const unmount = registry.mount(threadChangeRequestSnapshotsAtom);
      registry.set(threadChangeRequestSnapshotsAtom, new Map([[threadKey, snapshot]]));
      unmount();

      yield* Effect.yieldNow;

      const remount = registry.mount(threadChangeRequestSnapshotsAtom);
      expect(registry.get(threadChangeRequestSnapshotsAtom).get(threadKey)).toEqual(snapshot);

      remount();
      registry.dispose();
    }),
  );
});

describe("resolveVisibleVcsStatusTarget", () => {
  it("releases a row status target while its containing sidebar is hidden", () => {
    expect(
      resolveVisibleVcsStatusTarget({
        isVisible: false,
        shouldSubscribe: true,
        environmentId,
        cwd: "/repo",
      }),
    ).toBeNull();
  });

  it("retains a visible row target only when its row requires status", () => {
    expect(
      resolveVisibleVcsStatusTarget({
        isVisible: true,
        shouldSubscribe: true,
        environmentId,
        cwd: "/repo",
      }),
    ).toEqual({ environmentId, input: { cwd: "/repo" } });
    expect(
      resolveVisibleVcsStatusTarget({
        isVisible: true,
        shouldSubscribe: false,
        environmentId,
        cwd: "/repo",
      }),
    ).toBeNull();
  });
});

describe("thread PR lifecycle snapshots", () => {
  it("binds remote uncertainty to the locally observed ref", () => {
    expect(
      threadPrLifecycleSnapshot(
        status({ refName: "feature/b", remoteStatusKnown: false, pr: null }),
        targetKeyB,
      ),
    ).toEqual({ targetKey: targetKeyB, refName: "feature/b", state: undefined });
  });

  it("treats a local non-repository result as a known no-PR state", () => {
    expect(
      threadPrLifecycleSnapshot(
        status({ isRepo: false, refName: null, remoteStatusKnown: false, pr: null }),
        targetKeyA,
        "feature/a",
      ),
    ).toEqual({ targetKey: targetKeyA, refName: "feature/a", state: null });
  });

  it("invalidates a known ref A state when local status moves to ref B", () => {
    const next = mergeThreadPrLifecycleSnapshot(
      { targetKey: targetKeyA, refName: "feature/a", state: "merged" },
      { targetKey: targetKeyA, refName: "feature/b", state: undefined },
    );
    expect(next).toEqual({ targetKey: targetKeyA, refName: "feature/b", state: undefined });
    expect(resolveThreadPrLifecycleState(next, "feature/b", targetKeyA)).toBeUndefined();
  });

  it("preserves a known state through same-ref remote uncertainty", () => {
    expect(
      mergeThreadPrLifecycleSnapshot(
        { targetKey: targetKeyA, refName: "feature/a", state: "open" },
        { targetKey: targetKeyA, refName: "feature/a", state: undefined },
      ),
    ).toEqual({ targetKey: targetKeyA, refName: "feature/a", state: "open" });
  });

  it("uses lifecycle state only for the same branch and target", () => {
    const snapshot: ThreadPrLifecycleSnapshot = {
      targetKey: targetKeyA,
      refName: "feature/shared",
      state: "merged",
    };
    expect(resolveThreadPrLifecycleState(snapshot, "feature/shared", targetKeyA)).toBe("merged");
    expect(resolveThreadPrLifecycleState(snapshot, "feature/other", targetKeyA)).toBeUndefined();
    expect(resolveThreadPrLifecycleState(snapshot, "feature/shared", targetKeyB)).toBeUndefined();
  });

  it("treats branchless threads as known no-PR and normalizes cwd identity", () => {
    expect(resolveThreadPrLifecycleState(undefined, null, null)).toBeNull();
    expect(threadPrLifecycleTargetKey({ environmentId, cwd: "  /repo-a  " })).toBe(targetKeyA);
  });
});

describe("prStatusIndicator", () => {
  it("formats PR tooltips with number, uppercase status, and title", () => {
    expect(prStatusIndicator(status().pr, undefined)).toMatchObject({
      tooltip: "PR #42 - Open: PR branch",
      tooltipLead: "PR #42 - Open",
      tooltipTitle: "PR branch",
    });
  });

  it("uses red for closed pull requests", () => {
    const closedPr = status().pr;
    if (!closedPr) throw new Error("Expected pull request fixture");

    expect(prStatusIndicator({ ...closedPr, state: "closed" }, undefined)?.colorClass).toContain(
      "text-red-600",
    );
  });
});

describe("settledPrHoverColorClass", () => {
  it.each([
    ["open", "text-emerald-600"],
    ["merged", "text-violet-600"],
    ["closed", "text-red-600"],
  ] as const)("restores the %s pull request color on row hover", (state, colorClass) => {
    expect(settledPrHoverColorClass(state)).toContain(`group-hover/v2-row:${colorClass}`);
  });
});
