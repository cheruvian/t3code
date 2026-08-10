import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export interface SessionReconciliationResult {
  readonly inspected: number;
  readonly reconciled: number;
  readonly interrupted: number;
  readonly stopped: number;
  readonly remainingOrphans: ReadonlyArray<ThreadId>;
}

export class SessionReconciliationError extends Data.TaggedError("SessionReconciliationError")<{
  readonly cause: unknown;
}> {}

export interface SessionReconcilerShape {
  readonly reconcileOrphanedSessions: Effect.Effect<
    SessionReconciliationResult,
    SessionReconciliationError
  >;
  readonly interruptActiveSessions: Effect.Effect<
    SessionReconciliationResult,
    SessionReconciliationError
  >;
}

export class SessionReconciler extends Context.Service<SessionReconciler, SessionReconcilerShape>()(
  "t3/provider/Services/SessionReconciler",
) {}
