/**
 * Checkpoints projection - deliberately handles nothing.
 *
 * Checkpoint state reaches the read model through the turns projector, which
 * stores the ref, status and file list on the turn row it belongs to. This
 * projector keeps the name registered so its `projection_state` cursor keeps
 * advancing with the others: dropping it would strand that row, and a later
 * projector reusing the name would replay the whole log.
 *
 * It takes no repositories, which is why it is a plain definition rather than
 * a factory.
 *
 * @module projectors/checkpoints
 */
import { defineOrchestrationProjector, ORCHESTRATION_PROJECTOR_NAMES } from "./names.ts";

export const checkpointsProjector = defineOrchestrationProjector({
  name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
  reads: [],
  on: {},
});
