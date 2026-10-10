import { describe, expect, it } from "vite-plus/test";
import {
  readThreadFeedReturnPosition,
  rememberThreadFeedReturnPosition,
  resolveThreadFeedReturnTarget,
} from "./thread-feed-return-position";

describe("thread return position", () => {
  const rows = [{ id: "first" }, { id: "middle" }, { id: "last" }];
  const reading = {
    rowId: "middle",
    offsetWithinRow: 38,
    lastRowId: "last",
    atEnd: false,
  };

  it("resumes a saved row when the conversation has not changed", () => {
    rememberThreadFeedReturnPosition("env-a:thread-1", reading);
    expect(
      resolveThreadFeedReturnTarget(rows, readThreadFeedReturnPosition("env-a:thread-1")),
    ).toEqual({
      index: 1,
      viewPosition: 0,
      viewOffset: -38,
    });
    expect(readThreadFeedReturnPosition("env-b:thread-1")).toBeUndefined();
  });

  it("opens the newest message when another row arrived while away", () => {
    expect(resolveThreadFeedReturnTarget([...rows, { id: "new" }], reading)).toBeUndefined();
    expect(resolveThreadFeedReturnTarget(rows, { ...reading, atEnd: true })).toBeUndefined();
  });

  it("opens the newest message when the saved row was removed", () => {
    expect(resolveThreadFeedReturnTarget([{ id: "last" }], reading)).toBeUndefined();
  });
});
