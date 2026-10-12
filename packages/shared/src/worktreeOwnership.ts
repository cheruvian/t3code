import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";

/** Idle subagents belong to their parent's workspace, rather than owning it independently. */
export function getWorktreeCleanupOwners<
  T extends Pick<OrchestrationV2ThreadShell, "id" | "lineage">,
>(owners: readonly T[], targetThreadId: ThreadId, isIdle: (thread: T) => boolean): T[] {
  const byId = new Map(owners.map((thread) => [thread.id, thread]));
  return owners.filter((thread) => {
    if (thread.id === targetThreadId || !isIdle(thread)) return true;
    let current: T | undefined = thread;
    const visited = new Set<ThreadId>();
    while (current?.lineage.relationshipToParent === "subagent") {
      if (visited.has(current.id)) return true;
      visited.add(current.id);
      const parentId: ThreadId | null = current.lineage.parentThreadId;
      if (parentId === targetThreadId) return false;
      current = parentId === null ? undefined : byId.get(parentId);
    }
    return true;
  });
}
