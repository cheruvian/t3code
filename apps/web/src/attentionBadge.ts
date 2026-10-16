import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { hasUnseenCompletion, resolveThreadLastVisitedAt } from "./components/Sidebar.logic";

export function unreadDoneThreadKeys(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  lastVisitedByKey: Readonly<Record<string, string>>,
): Set<string> {
  const keys = new Set<string>();
  for (const shell of shells) {
    if (shell.archivedAt != null || shell.lineage?.relationshipToParent === "subagent") continue;
    const key = scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id));
    if (
      hasUnseenCompletion({
        ...shell,
        lastVisitedAt: resolveThreadLastVisitedAt(shell.lastVisitedAt, lastVisitedByKey[key]),
      })
    ) {
      keys.add(key);
    }
  }
  return keys;
}

export function diffNewlyFinished(
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>,
): string[] {
  return [...next].filter((key) => !previous.has(key));
}

export function shouldPlaySessionFinishSound(
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>,
  enabled: boolean,
  initialized: boolean,
): boolean {
  return initialized && enabled && diffNewlyFinished(previous, next).length > 0;
}
