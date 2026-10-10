import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  representedThreadKeys,
  useOptimisticThreadListStore,
  visibleOptimisticThreads,
} from "./optimisticThreadListStore";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
const entry = {
  threadRef,
  projectId,
  title: "Investigate startup",
  createdAt: "2026-09-26T12:00:00.000Z",
  draftId: null,
};

afterEach(() => useOptimisticThreadListStore.setState({ entriesByKey: {} }));

describe("optimistic thread list", () => {
  it("shows a pending thread immediately and yields to its server shell", () => {
    useOptimisticThreadListStore.getState().add(entry);
    const pending = useOptimisticThreadListStore.getState().entriesByKey;
    expect(visibleOptimisticThreads(pending, new Set(), null)).toEqual([entry]);
    expect(visibleOptimisticThreads(pending, new Set([scopedThreadKey(threadRef)]), null)).toEqual(
      [],
    );
  });

  it("removes failed creations and obeys the project scope", () => {
    useOptimisticThreadListStore.getState().add(entry);
    const pending = useOptimisticThreadListStore.getState().entriesByKey;
    expect(visibleOptimisticThreads(pending, new Set(), new Set(["environment-1:other"]))).toEqual(
      [],
    );
    useOptimisticThreadListStore.getState().remove(threadRef);
    expect(useOptimisticThreadListStore.getState().entriesByKey).toEqual({});
  });

  it("gives a submitted draft one list row through creation, failure, and shell handoff", () => {
    const key = scopedThreadKey(threadRef);
    const canonical = new Set<string>();
    const rowCount = () => {
      const pending = useOptimisticThreadListStore.getState().entriesByKey;
      return (
        Number(!representedThreadKeys(canonical, pending).has(key)) +
        visibleOptimisticThreads(pending, canonical, null).length +
        Number(canonical.has(key))
      );
    };
    expect(rowCount()).toBe(1); // A visible saved draft.

    useOptimisticThreadListStore.getState().add(entry);
    expect(rowCount()).toBe(1); // The creating thread replaces its draft row.

    useOptimisticThreadListStore.getState().remove(threadRef);
    expect(rowCount()).toBe(1); // A failed creation returns to its draft.

    canonical.add(key);
    expect(rowCount()).toBe(1); // The server thread owns the row after handoff.
  });
});
