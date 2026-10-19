import * as Schema from "effect/Schema";
import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Local deployment runner's immutable release request. No executable paths cross the wire. */
export const ManagedDeploymentRequest = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  revision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  queuedAt: TrimmedNonEmptyString,
  status: Schema.Literals(["queued", "installing", "failed"]),
});
export type ManagedDeploymentRequest = typeof ManagedDeploymentRequest.Type;
export const ManagedDeploymentState = Schema.NullOr(
  Schema.Struct({
    ...ManagedDeploymentRequest.fields,
    busyThreads: NonNegativeInt,
    pendingEffects: NonNegativeInt,
    blockingThreads: Schema.optional(
      Schema.Array(Schema.Struct({ threadId: ThreadId, title: Schema.String })),
    ),
  }),
);
export type ManagedDeploymentState = typeof ManagedDeploymentState.Type;
export const ManagedDeploymentAction = Schema.Struct({
  id: TrimmedNonEmptyString,
  action: Schema.Literals(["force", "cancel"]),
});
export class ManagedDeploymentError extends Schema.TaggedError<ManagedDeploymentError>()(
  "ManagedDeploymentError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return "Could not update the queued deployment. Refresh and try again.";
  }
}
