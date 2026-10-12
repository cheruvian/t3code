import type { ThreadShell } from "./types";
import { threadShellIsIdleForWorktreeCleanup } from "@t3tools/client-runtime/state/models";
import { getWorktreeCleanupOwners } from "@t3tools/shared/worktreeOwnership";

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

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

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  const owners = getWorktreeCleanupOwners(
    threads.filter((thread) => normalizeWorktreePath(thread.worktreePath) === targetWorktreePath),
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
