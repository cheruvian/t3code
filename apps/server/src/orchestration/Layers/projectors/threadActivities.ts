/**
 * Thread activities projection - the timeline rows the UI renders between
 * messages.
 *
 * @module projectors/threadActivities
 */
import * as Effect from "effect/Effect";

import {
  type ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
} from "../../../persistence/Services/ProjectionThreadActivities.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../../persistence/Services/ProjectionTurns.ts";
import {
  type OrchestrationEventOfType as EventOf,
  type ProjectorHandlers,
} from "../ProjectorRegistry.ts";
import { defineOrchestrationProjector, ORCHESTRATION_PROJECTOR_NAMES } from "./names.ts";

function retainProjectionActivitiesAfterRevert(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadActivity> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

export const makeThreadActivitiesProjector = Effect.fn("makeThreadActivitiesProjector")(
  function* () {
    const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;

    const threadActivitiesHandlers = {
      "thread.activity-appended": Effect.fn(
        "projection.thread-activities:thread.activity-appended",
      )(function* (event: EventOf<"thread.activity-appended">) {
        yield* projectionThreadActivityRepository.upsert({
          activityId: event.payload.activity.id,
          threadId: event.payload.threadId,
          turnId: event.payload.activity.turnId,
          tone: event.payload.activity.tone,
          kind: event.payload.activity.kind,
          summary: event.payload.activity.summary,
          payload: event.payload.activity.payload,
          ...(event.payload.activity.sequence !== undefined
            ? { sequence: event.payload.activity.sequence }
            : {}),
          createdAt: event.payload.activity.createdAt,
        });
      }),

      "thread.reverted": Effect.fn("projection.thread-activities:thread.reverted")(function* (
        event: EventOf<"thread.reverted">,
      ) {
        const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        if (existingRows.length === 0) {
          return;
        }
        const existingTurns = yield* projectionTurnRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        const keptRows = retainProjectionActivitiesAfterRevert(
          existingRows,
          existingTurns,
          event.payload.turnCount,
        );
        if (keptRows.length === existingRows.length) {
          return;
        }
        yield* projectionThreadActivityRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
          concurrency: 1,
        }).pipe(Effect.asVoid);
      }),
    } satisfies ProjectorHandlers;

    return defineOrchestrationProjector({
      name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
      reads: [],
      on: threadActivitiesHandlers,
    });
  },
);
