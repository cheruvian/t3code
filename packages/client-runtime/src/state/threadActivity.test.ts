import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { orderThreadActivities, upsertThreadActivity } from "./threadActivity.ts";

describe("upsertThreadActivity", () => {
  it("uses one boundary comparison and no full sort for a monotonic append", () => {
    let existingSequenceReads = 0;
    const activities = Array.from(
      { length: 128 },
      (_, index) =>
        ({
          id: EventId.make(`activity-${index.toString().padStart(3, "0")}`),
          tone: "tool" as const,
          kind: "command",
          summary: `Command ${index}`,
          payload: {},
          turnId: TurnId.make("turn-1"),
          get sequence() {
            existingSequenceReads += 1;
            return index;
          },
          createdAt: "2026-04-01T11:00:00.000Z",
        }) satisfies OrchestrationThreadActivity,
    );
    const ordered = orderThreadActivities(activities);
    existingSequenceReads = 0;
    const sort = vi.spyOn(Array.prototype, "sort");
    try {
      const next = upsertThreadActivity(ordered, {
        id: EventId.make("activity-128"),
        tone: "tool",
        kind: "command",
        summary: "Command 128",
        payload: {},
        turnId: TurnId.make("turn-1"),
        sequence: 128,
        createdAt: "2026-04-01T11:00:01.000Z",
      });

      expect(next).toHaveLength(129);
      expect(next.at(-1)?.id).toBe("activity-128");
      expect(existingSequenceReads).toBe(1);
      expect(sort).not.toHaveBeenCalled();
    } finally {
      sort.mockRestore();
    }
  });
});
