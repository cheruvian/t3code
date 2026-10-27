import { useEffect } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  useOptimisticThreadListStore,
  visibleOptimisticThreads,
} from "../../optimisticThreadListStore";

export function SidebarCreatingBlock(props: {
  canonicalThreadKeys: ReadonlySet<string>;
  scopedProjectKeys: ReadonlySet<string> | null;
  onNavigate: (ref: ScopedThreadRef) => void;
}) {
  const entries = useOptimisticThreadListStore((state) => state.entriesByKey);
  // oxlint-disable-next-line t3code/react-effect-budget -- Retire external store entries when server shells acknowledge creation.
  useEffect(() => {
    for (const entry of Object.values(entries)) {
      if (props.canonicalThreadKeys.has(scopedThreadKey(entry.threadRef))) {
        useOptimisticThreadListStore.getState().remove(entry.threadRef);
      }
    }
  }, [entries, props.canonicalThreadKeys]);
  return visibleOptimisticThreads(entries, props.canonicalThreadKeys, props.scopedProjectKeys).map(
    (entry) => (
      <li key={scopedThreadKey(entry.threadRef)} className="list-none py-0.5">
        <button
          type="button"
          className="w-full rounded-md bg-sidebar-row-active px-(--sidebar-row-content-inset) py-(--sidebar-content-inset) text-left text-sidebar-foreground"
          onClick={() => props.onNavigate(entry.threadRef)}
          aria-label={`Creating thread: ${entry.title}`}
        >
          <div className="truncate text-sm">{entry.title}</div>
          <div className="text-xs text-muted-foreground">Creating thread…</div>
        </button>
      </li>
    ),
  );
}
