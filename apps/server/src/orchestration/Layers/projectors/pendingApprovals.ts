/**
 * Pending approvals projection - one row per approval request, opened by an
 * approval activity and resolved by a decision or a stale-request failure.
 *
 * @module projectors/pendingApprovals
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionPendingApprovalRepository } from "../../../persistence/Services/ProjectionPendingApprovals.ts";
import { extractActivityRequestId } from "./shared.ts";
import {
  type OrchestrationEventOfType as EventOf,
  type ProjectorHandlers,
} from "../ProjectorRegistry.ts";
import { defineOrchestrationProjector, ORCHESTRATION_PROJECTOR_NAMES } from "./names.ts";

function isStalePendingApprovalFailureDetail(detail: string | null): boolean {
  if (detail === null) {
    return false;
  }
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request")
  );
}

export const makePendingApprovalsProjector = Effect.fn("makePendingApprovalsProjector")(
  function* () {
    const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;

    const pendingApprovalsHandlers = {
      "thread.activity-appended": Effect.fn(
        "projection.pending-approvals:thread.activity-appended",
      )(function* (event: EventOf<"thread.activity-appended">) {
        const requestId =
          extractActivityRequestId(event.payload.activity.payload) ??
          event.metadata.requestId ??
          null;
        if (requestId === null) {
          return;
        }
        const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
          requestId,
        });
        if (event.payload.activity.kind === "approval.resolved") {
          const resolvedDecisionRaw =
            typeof event.payload.activity.payload === "object" &&
            event.payload.activity.payload !== null &&
            "decision" in event.payload.activity.payload
              ? (event.payload.activity.payload as { decision?: unknown }).decision
              : null;
          const resolvedDecision =
            resolvedDecisionRaw === "accept" ||
            resolvedDecisionRaw === "acceptForSession" ||
            resolvedDecisionRaw === "decline" ||
            resolvedDecisionRaw === "cancel"
              ? resolvedDecisionRaw
              : null;
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            threadId: Option.isSome(existingRow)
              ? existingRow.value.threadId
              : event.payload.threadId,
            turnId: Option.isSome(existingRow)
              ? existingRow.value.turnId
              : event.payload.activity.turnId,
            status: "resolved",
            decision: resolvedDecision,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.activity.createdAt,
            resolvedAt: event.payload.activity.createdAt,
          });
          return;
        }
        if (event.payload.activity.kind === "provider.approval.respond.failed") {
          const payload =
            typeof event.payload.activity.payload === "object" &&
            event.payload.activity.payload !== null
              ? (event.payload.activity.payload as Record<string, unknown>)
              : null;
          const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
          if (isStalePendingApprovalFailureDetail(detail)) {
            if (Option.isNone(existingRow)) {
              return;
            }
            if (existingRow.value.status === "resolved") {
              return;
            }
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: existingRow.value.threadId,
              turnId: existingRow.value.turnId,
              status: "resolved",
              decision: null,
              createdAt: existingRow.value.createdAt,
              resolvedAt: event.payload.activity.createdAt,
            });
            return;
          }
          return;
        }
        // Only approval-requested activities should create pending-approval
        // rows.  Other activity kinds that happen to carry a requestId
        // (e.g. user-input.requested / user-input.resolved) must not
        // pollute this projection — they have their own accounting via
        // derivePendingUserInputCountFromActivities.
        if (event.payload.activity.kind !== "approval.requested") {
          return;
        }
        if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
          return;
        }
        yield* projectionPendingApprovalRepository.upsert({
          requestId,
          threadId: event.payload.threadId,
          turnId: event.payload.activity.turnId,
          status: "pending",
          decision: null,
          createdAt: Option.isSome(existingRow)
            ? existingRow.value.createdAt
            : event.payload.activity.createdAt,
          resolvedAt: null,
        });
      }),

      "thread.approval-response-requested": Effect.fn(
        "projection.pending-approvals:thread.approval-response-requested",
      )(function* (event: EventOf<"thread.approval-response-requested">) {
        const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
          requestId: event.payload.requestId,
        });
        yield* projectionPendingApprovalRepository.upsert({
          requestId: event.payload.requestId,
          threadId: Option.isSome(existingRow)
            ? existingRow.value.threadId
            : event.payload.threadId,
          turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
          status: "resolved",
          decision: event.payload.decision,
          createdAt: Option.isSome(existingRow)
            ? existingRow.value.createdAt
            : event.payload.createdAt,
          resolvedAt: event.payload.createdAt,
        });
      }),
    } satisfies ProjectorHandlers;

    return defineOrchestrationProjector({
      name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
      reads: [],
      on: pendingApprovalsHandlers,
    });
  },
);
