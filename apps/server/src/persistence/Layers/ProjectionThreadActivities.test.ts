import { EventId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const threadId = ThreadId.make("thread-activity-order");
const tiedAt = "2026-04-01T11:00:00.000Z";

function activity(
  id: string,
  kind: string,
  createdAt: string,
  sequence?: number,
  summary = id,
  owner = threadId,
) {
  return {
    activityId: EventId.make(id),
    threadId: owner,
    turnId: TurnId.make("turn-1"),
    tone: "tool" as const,
    kind,
    summary,
    payload: {},
    ...(sequence === undefined ? {} : { sequence }),
    createdAt,
  };
}

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("lists mixed activity history in canonical order", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const rows = [
        activity("activity-a-completed", "tool.completed", tiedAt, 2),
        activity("activity-c-progress", "tool.progress", tiedAt, 2),
        activity("activity-b-other", "file-edit", tiedAt, 2),
        activity("activity-z-started", "tool.started", tiedAt, 2),
        activity("activity-created-earlier", "tool.completed", "2026-04-01T10:00:00.000Z", 2),
        activity("activity-sequence-one", "command", "2026-04-01T12:00:00.000Z", 1),
        activity("activity-legacy", "command", "2026-04-01T12:00:00.000Z"),
      ];
      for (const row of rows) {
        yield* repository.upsert(row);
      }

      const persisted = yield* repository.listByThreadId({ threadId });
      assert.deepStrictEqual(
        persisted.map((row) => row.activityId),
        [
          "activity-legacy",
          "activity-sequence-one",
          "activity-created-earlier",
          "activity-z-started",
          "activity-b-other",
          "activity-c-progress",
          "activity-a-completed",
        ],
      );
    }),
  );

  it.effect("replaces a stable activity ID when its lifecycle kind changes", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const stableThreadId = ThreadId.make("thread-stable-activity");
      yield* repository.upsert(
        activity("activity-stable", "tool.completed", tiedAt, 2, "Stale activity", stableThreadId),
      );
      yield* repository.upsert(
        activity(
          "activity-stable",
          "tool.started",
          tiedAt,
          2,
          "Replacement activity",
          stableThreadId,
        ),
      );

      const persisted = yield* repository.listByThreadId({ threadId: stableThreadId });
      assert.deepStrictEqual(
        persisted.map((row) => ({ kind: row.kind, summary: row.summary })),
        [{ kind: "tool.started", summary: "Replacement activity" }],
      );
    }),
  );
});
