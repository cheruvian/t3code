/**
 * Proposed plans projection - one row per plan a turn proposed.
 *
 * @module projectors/threadProposedPlans
 */
import * as Effect from "effect/Effect";

import {
  type ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
} from "../../../persistence/Services/ProjectionThreadProposedPlans.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../../persistence/Services/ProjectionTurns.ts";
import {
  type OrchestrationEventOfType as EventOf,
  type ProjectorHandlers,
} from "../ProjectorRegistry.ts";
import { defineOrchestrationProjector, ORCHESTRATION_PROJECTOR_NAMES } from "./names.ts";

function retainProjectionProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadProposedPlan> {
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
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

export const makeThreadProposedPlansProjector = Effect.fn("makeThreadProposedPlansProjector")(
  function* () {
    const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;

    const threadProposedPlansHandlers = {
      "thread.proposed-plan-upserted": Effect.fn(
        "projection.thread-proposed-plans:thread.proposed-plan-upserted",
      )(function* (event: EventOf<"thread.proposed-plan-upserted">) {
        yield* projectionThreadProposedPlanRepository.upsert({
          planId: event.payload.proposedPlan.id,
          threadId: event.payload.threadId,
          turnId: event.payload.proposedPlan.turnId,
          planMarkdown: event.payload.proposedPlan.planMarkdown,
          implementedAt: event.payload.proposedPlan.implementedAt,
          implementationThreadId: event.payload.proposedPlan.implementationThreadId,
          createdAt: event.payload.proposedPlan.createdAt,
          updatedAt: event.payload.proposedPlan.updatedAt,
        });
      }),

      "thread.reverted": Effect.fn("projection.thread-proposed-plans:thread.reverted")(function* (
        event: EventOf<"thread.reverted">,
      ) {
        const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        if (existingRows.length === 0) {
          return;
        }

        const existingTurns = yield* projectionTurnRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        const keptRows = retainProjectionProposedPlansAfterRevert(
          existingRows,
          existingTurns,
          event.payload.turnCount,
        );
        if (keptRows.length === existingRows.length) {
          return;
        }

        yield* projectionThreadProposedPlanRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
          concurrency: 1,
        }).pipe(Effect.asVoid);
      }),
    } satisfies ProjectorHandlers;

    return defineOrchestrationProjector({
      name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
      reads: [],
      on: threadProposedPlansHandlers,
    });
  },
);
