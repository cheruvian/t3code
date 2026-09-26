import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
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
});
