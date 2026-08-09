/**
 * Projector names - the identity each projector stores its cursor under.
 *
 * Renaming one orphans its `projection_state` row and replays that projector
 * from the start of the log, so treat these as persisted values.
 *
 * @module projectors/names
 */
import { defineProjector, type ProjectorDefinition } from "../ProjectorRegistry.ts";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  threads: "projection.threads",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadActivities: "projection.thread-activities",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
} as const;

export type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

/**
 * `defineProjector` with the name space pinned to this application's projectors.
 *
 * The generic `defineProjector` infers its name type from what it is given, so
 * a misspelled dependency would only fail where the registry is assembled.
 * Pinning it here fails in the module that wrote the mistake instead.
 */
export const defineOrchestrationProjector = (
  definition: ProjectorDefinition<ProjectorName>,
): ProjectorDefinition<ProjectorName> => defineProjector(definition);
