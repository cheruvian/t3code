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

export const SESSION_RECONCILIATION_PHASE = "provider-sessions.reconcile" as const;

export type SessionReconciliationOperation =
  | "reconcile-orphaned-sessions"
  | "interrupt-active-sessions";

export type SessionReconciliationFailureKind = "operation-failed" | "orphans-remain";

export class SessionReconciliationDidNotConverge extends Data.TaggedError(
  "SessionReconciliationDidNotConverge",
)<{
  readonly affectedThreadIds: ReadonlyArray<ThreadId>;
}> {}

export class SessionReconciliationError extends Data.TaggedError("SessionReconciliationError")<{
  readonly phase: typeof SESSION_RECONCILIATION_PHASE;
  readonly operation: SessionReconciliationOperation;
  readonly failureKind: SessionReconciliationFailureKind;
  readonly affectedThreadIds: ReadonlyArray<ThreadId>;
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
