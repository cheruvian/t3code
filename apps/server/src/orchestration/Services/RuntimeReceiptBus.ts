/**
 * RuntimeReceiptBus - Internal checkpoint-reactor synchronization receipts.
 *
 * This service exists to expose short-lived orchestration milestones that are
 * useful in tests and harnesses but are not part of the production runtime
 * event model. `CheckpointReactor` publishes receipts such as baseline capture,
 * diff finalization, and turn-processing quiescence so integration tests can
 * wait for those exact points without inferring them indirectly from persisted
 * state.
 *
 * Live reactors subscribe through `streamReceipts`. Tests may independently
 * subscribe via `streamEventsForTest` to await the same milestones.
 *
 * @module RuntimeReceiptBus
 */
import {
  CheckpointRef,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export const CheckpointBaselineCapturedReceipt = Schema.Struct({
  type: Schema.Literal("checkpoint.baseline.captured"),
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  createdAt: IsoDateTime,
});
export type CheckpointBaselineCapturedReceipt = typeof CheckpointBaselineCapturedReceipt.Type;

export const CheckpointDiffFinalizedReceipt = Schema.Struct({
  type: Schema.Literal("checkpoint.diff.finalized"),
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: Schema.Literals(["ready", "missing", "error"]),
  createdAt: IsoDateTime,
});
export type CheckpointDiffFinalizedReceipt = typeof CheckpointDiffFinalizedReceipt.Type;

export const TurnProcessingQuiescedReceipt = Schema.Struct({
  type: Schema.Literal("turn.processing.quiesced"),
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type TurnProcessingQuiescedReceipt = typeof TurnProcessingQuiescedReceipt.Type;

export const TurnIngestionSettledReceipt = Schema.Struct({
  type: Schema.Literal("turn.ingestion-settled"),
  sourceEventId: EventId,
  threadId: ThreadId,
  turnId: TurnId,
  outcome: Schema.Literals(["completed", "failed", "interrupted", "cancelled"]),
  settledAt: IsoDateTime,
});
export type TurnIngestionSettledReceipt = typeof TurnIngestionSettledReceipt.Type;

export const OrchestrationRuntimeReceipt = Schema.Union([
  CheckpointBaselineCapturedReceipt,
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
  TurnIngestionSettledReceipt,
]);
export type OrchestrationRuntimeReceipt = typeof OrchestrationRuntimeReceipt.Type;

export interface RuntimeReceiptBusShape {
  readonly publish: (receipt: OrchestrationRuntimeReceipt) => Effect.Effect<void>;
  readonly streamReceipts: Stream.Stream<OrchestrationRuntimeReceipt>;
  readonly streamEventsForTest: Stream.Stream<OrchestrationRuntimeReceipt>;
}

export class RuntimeReceiptBus extends Context.Service<RuntimeReceiptBus, RuntimeReceiptBusShape>()(
  "t3/orchestration/Services/RuntimeReceiptBus",
) {}
