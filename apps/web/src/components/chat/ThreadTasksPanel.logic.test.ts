import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { TurnPlanEntry } from "../../session-logic";
import { partitionThreadTasks, resolveThreadTasksGutter } from "./ThreadTasksPanel.logic";

function plan(id: string, status: "completed" | "pending"): TurnPlanEntry {
  const runId = RunId.make(id);
  return {
    id,
    runId,
    createdAt: "2026-10-08T12:00:00Z",
    plan: {
      runId,
      createdAt: "2026-10-08T12:00:00Z",
      steps: [{ step: id, status }],
    },
  };
}

describe("thread task history", () => {
  it("archives finished tasks immediately and brings new work back into the active list", () => {
    const completed = plan("current", "completed");
    expect(partitionThreadTasks([completed], completed.runId)).toEqual({
      active: null,
      history: [completed],
    });
    const updated = plan("current", "pending");
    expect(partitionThreadTasks([updated], updated.runId)).toEqual({
      active: updated,
      history: [],
    });
  });

  it("keeps unfinished older turns in history, newest first", () => {
    const old = plan("old", "pending");
    const recent = plan("recent", "completed");
    const active = plan("active", "pending");
    const plans = [old, recent, active];
    expect(partitionThreadTasks(plans, active.runId)).toEqual({
      active,
      history: [recent, old],
    });
    expect(partitionThreadTasks(plans, null)).toEqual({
      active: null,
      history: [active, recent, old],
    });
    expect(plans).toEqual([old, recent, active]);
  });

  it("does not reuse a previous turn's tasks while a new turn has no plan", () => {
    const old = plan("old", "pending");
    expect(partitionThreadTasks([old], RunId.make("new"))).toEqual({
      active: null,
      history: [old],
    });
  });
});

describe("tasks gutter", () => {
  it("falls back inline when there is not enough room beside the conversation", () => {
    expect(resolveThreadTasksGutter(980, 1000, 20)).toBeNull();
    expect(resolveThreadTasksGutter(713, 1000, 20)).toBeNull();
    expect(resolveThreadTasksGutter(712, 1000, 20)).toEqual({ left: 760, width: 220 });
    expect(resolveThreadTasksGutter(500, 1000, 20)).toEqual({ left: 700, width: 280 });
  });
});
