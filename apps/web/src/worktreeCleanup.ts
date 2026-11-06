import { threadShellIsIdleForWorktreeCleanup } from "@t3tools/client-runtime/state/models";
import { getWorktreeCleanupOwners } from "@t3tools/shared/worktreeOwnership";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import type { ThreadShell } from "./types";

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<
    Pick<
      ThreadShell,
      | "id"
      | "worktreePath"
      | "lineage"
      | "runtime"
      | "pendingBackgroundTasks"
      | "hasPendingApprovals"
      | "hasPendingUserInput"
    >
  >,
  threadId: ThreadShell["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = targetThread.worktreePath?.trim();
  if (!targetWorktreePath) {
    return null;
  }

  const owners = getWorktreeCleanupOwners(
    threads.filter(
      (thread) =>
        thread.worktreePath !== null &&
        normalizeProjectPathForComparison(thread.worktreePath) ===
          normalizeProjectPathForComparison(targetWorktreePath),
    ),
    threadId,
    threadShellIsIdleForWorktreeCleanup,
  );
  return owners.length === 1 ? targetWorktreePath : null;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}
