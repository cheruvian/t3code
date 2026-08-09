/**
 * Projects projection - one row per project.
 *
 * @module projectors/projects
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionProjectRepository } from "../../../persistence/Services/ProjectionProjects.ts";
import {
  type OrchestrationEventOfType as EventOf,
  type ProjectorHandlers,
} from "../ProjectorRegistry.ts";
import { defineOrchestrationProjector, ORCHESTRATION_PROJECTOR_NAMES } from "./names.ts";

export const makeProjectsProjector = Effect.fn("makeProjectsProjector")(function* () {
  const projectionProjectRepository = yield* ProjectionProjectRepository;

  const projectsHandlers = {
    "project.created": Effect.fn("projection.projects:project.created")(function* (
      event: EventOf<"project.created">,
    ) {
      yield* projectionProjectRepository.upsert({
        projectId: event.payload.projectId,
        title: event.payload.title,
        workspaceRoot: event.payload.workspaceRoot,
        defaultModelSelection: event.payload.defaultModelSelection,
        defaultThreadEnvMode: null,
        faviconPath: event.payload.faviconPath ?? null,
        scripts: event.payload.scripts,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        deletedAt: null,
      });
    }),

    "project.meta-updated": Effect.fn("projection.projects:project.meta-updated")(function* (
      event: EventOf<"project.meta-updated">,
    ) {
      const existingRow = yield* projectionProjectRepository.getById({
        projectId: event.payload.projectId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionProjectRepository.upsert({
        ...existingRow.value,
        ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
        ...(event.payload.workspaceRoot !== undefined
          ? { workspaceRoot: event.payload.workspaceRoot }
          : {}),
        ...(event.payload.defaultModelSelection !== undefined
          ? { defaultModelSelection: event.payload.defaultModelSelection }
          : {}),
        ...(event.payload.defaultThreadEnvMode !== undefined
          ? { defaultThreadEnvMode: event.payload.defaultThreadEnvMode }
          : {}),
        ...(event.payload.faviconPath !== undefined
          ? { faviconPath: event.payload.faviconPath }
          : {}),
        ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
        updatedAt: event.payload.updatedAt,
      });
    }),

    "project.deleted": Effect.fn("projection.projects:project.deleted")(function* (
      event: EventOf<"project.deleted">,
    ) {
      const existingRow = yield* projectionProjectRepository.getById({
        projectId: event.payload.projectId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionProjectRepository.upsert({
        ...existingRow.value,
        deletedAt: event.payload.deletedAt,
        updatedAt: event.payload.deletedAt,
      });
    }),
  } satisfies ProjectorHandlers;

  return defineOrchestrationProjector({
    name: ORCHESTRATION_PROJECTOR_NAMES.projects,
    reads: [],
    on: projectsHandlers,
  });
});
