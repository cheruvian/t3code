import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import type { DraftId } from "./composerDraftStore";

export interface OptimisticThreadListEntry {
  threadRef: ScopedThreadRef;
  projectId: ProjectId;
  title: string;
  createdAt: string;
  draftId: DraftId | null;
}

interface OptimisticThreadListState {
  entriesByKey: Record<string, OptimisticThreadListEntry>;
  add: (entry: OptimisticThreadListEntry) => void;
  remove: (threadRef: ScopedThreadRef) => void;
}

export const useOptimisticThreadListStore = create<OptimisticThreadListState>()((set) => ({
  entriesByKey: {},
  add: (entry) =>
    set((state) => ({
      entriesByKey: {
        ...state.entriesByKey,
        [scopedThreadKey(entry.threadRef)]: entry,
      },
    })),
  remove: (threadRef) =>
    set((state) => {
      const key = scopedThreadKey(threadRef);
      if (!(key in state.entriesByKey)) return state;
      const entriesByKey = { ...state.entriesByKey };
      delete entriesByKey[key];
      return { entriesByKey };
    }),
}));

export function visibleOptimisticThreads(
  entriesByKey: Readonly<Record<string, OptimisticThreadListEntry>>,
  canonicalThreadKeys: ReadonlySet<string>,
  scopedProjectKeys: ReadonlySet<string> | null,
): OptimisticThreadListEntry[] {
  return Object.entries(entriesByKey)
    .filter(
      ([key, entry]) =>
        !canonicalThreadKeys.has(key) &&
        (scopedProjectKeys === null ||
          scopedProjectKeys.has(`${entry.threadRef.environmentId}:${entry.projectId}`)),
    )
    .map(([, entry]) => entry)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** A submitted draft has one list row throughout optimistic and server handoff. */
export function representedThreadKeys(
  canonicalThreadKeys: ReadonlySet<string>,
  entriesByKey: Readonly<Record<string, OptimisticThreadListEntry>>,
): ReadonlySet<string> {
  return new Set([...canonicalThreadKeys, ...Object.keys(entriesByKey)]);
}
