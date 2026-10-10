import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  beginThreadMoveProgress,
  getActiveThreadMoves,
  isThreadMoveInProgress,
} from "./threadMoveProgress.ts";

it("keeps progress scoped to each thread and allows retry after cleanup", () => {
  const ref = { environmentId: EnvironmentId.make("source"), threadId: ThreadId.make("thread") };
  const other = { ...ref, environmentId: EnvironmentId.make("other") };
  const first = beginThreadMoveProgress(ref, "Destination")!;
  try {
    expect(beginThreadMoveProgress(ref, "Destination")).toBeNull();
    expect(isThreadMoveInProgress(other)).toBe(false);
    first.update({ phase: "uploading", transferredBytes: 500_000, totalBytes: 1_000_000 });
    expect(getActiveThreadMoves()[0]?.description).toBe("Transferring 0.5 / 1.0 MB (50%)");
  } finally {
    first.finish();
  }
  expect(isThreadMoveInProgress(ref)).toBe(false);
  const retry = beginThreadMoveProgress(ref, "Destination");
  expect(retry).not.toBeNull();
  retry?.finish();
  expect(getActiveThreadMoves()).toEqual([]);
});
