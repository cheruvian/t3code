import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ThreadMoveImportReceipt,
  ThreadMovePortableManifest,
  ThreadMoveCancellationReceipt,
} from "./orchestrationV2.ts";

export const THREAD_MOVE_RPC = "orchestration.threadMove";
export const ThreadMoveId = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,80}$/));
const identity = { moveId: ThreadMoveId, threadId: ThreadId };
export const ThreadMoveRequest = Schema.Union([
  Schema.Struct({
    ...identity,
    action: Schema.Literal("export"),
    destinationEnvironmentId: EnvironmentId,
    destinationHeadCommit: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    ...identity,
    action: Schema.Literal("begin"),
    manifest: ThreadMovePortableManifest,
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
    branch: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    ...identity,
    action: Schema.Literal("status"),
    projectId: Schema.optional(ProjectId),
  }),
  Schema.Struct({
    ...identity,
    action: Schema.Literals(["commit", "cancel", "activate", "abort", "prepareUndo", "undo"]),
  }),
  Schema.Struct({
    ...identity,
    action: Schema.Literals(["recover", "restore"]),
    cancellation: ThreadMoveCancellationReceipt,
  }),
  Schema.Struct({
    ...identity,
    action: Schema.Literal("finalize"),
    receipt: ThreadMoveImportReceipt,
  }),
]);
export type ThreadMoveRequest = typeof ThreadMoveRequest.Type;

export const ThreadMoveResponse = Schema.Struct({
  state: Schema.Literals([
    "idle",
    "fenced",
    "uploading",
    "activating",
    "committed",
    "cancelled",
    "moved",
  ]),
  manifest: Schema.optional(ThreadMovePortableManifest),
  repositoryHeadCommit: Schema.optional(Schema.String),
  relativeUrl: Schema.optional(Schema.String),
  offset: Schema.optional(Schema.Number),
  receipt: Schema.optional(ThreadMoveImportReceipt),
  cancellation: Schema.optional(ThreadMoveCancellationReceipt),
});
export type ThreadMoveResponse = typeof ThreadMoveResponse.Type;
export class ThreadMoveTransferError extends Schema.TaggedError<ThreadMoveTransferError>()(
  "ThreadMoveTransferError",
  { message: Schema.String },
) {}
