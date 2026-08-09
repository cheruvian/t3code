/**
 * Thread sessions projection - the current provider session per thread.
 *
 * @module projectors/threadSessions
 */
import * as Effect from "effect/Effect";

import { ProjectionThreadSessionRepository } from "../../../persistence/Services/ProjectionThreadSessions.ts";
import {
  type OrchestrationEventOfType as EventOf,
  type ProjectorHandlers,
} from "../ProjectorRegistry.ts";
import { defineOrchestrationProjector, ORCHESTRATION_PROJECTOR_NAMES } from "./names.ts";

export const makeThreadSessionsProjector = Effect.fn("makeThreadSessionsProjector")(function* () {
  const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;

  const threadSessionsHandlers = {
    "thread.session-set": Effect.fn("projection.thread-sessions:thread.session-set")(function* (
      event: EventOf<"thread.session-set">,
    ) {
      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        providerInstanceId: event.payload.session.providerInstanceId ?? null,
        runtimeMode: event.payload.session.runtimeMode,
        activeTurnId: event.payload.session.activeTurnId,
        lastError: event.payload.session.lastError,
        updatedAt: event.payload.session.updatedAt,
      });
    }),
  } satisfies ProjectorHandlers;

  return defineOrchestrationProjector({
    name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
    reads: [],
    on: threadSessionsHandlers,
  });
});
