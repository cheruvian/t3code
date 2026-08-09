/**
 * Threads projection - the thread row plus its denormalized shell summary.
 *
 * This is the one projector that derives state from other projections, which
 * is why it declares `reads`: the summary counts rows those projections own.
 *
 * @module projectors/threads
 */
import { type OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionPendingApprovalRepository } from "../../../persistence/Services/ProjectionPendingApprovals.ts";
import {
  type ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
} from "../../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
} from "../../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadRepository } from "../../../persistence/Services/ProjectionThreads.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../../persistence/Services/ProjectionTurns.ts";
import { extractActivityRequestId } from "./shared.ts";
import {
  defineProjector,
  type AttachmentSideEffects,
  type OrchestrationEventOfType as EventOf,
  type ProjectorHandlers,
} from "../ProjectorRegistry.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./names.ts";

const PENDING_APPROVAL_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
]);

const PENDING_USER_INPUT_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
]);

interface ThreadShellSummaryFields {
  readonly latestUserMessageAt?: boolean;
  readonly pendingApprovalCount?: boolean;
  readonly pendingUserInputCount?: boolean;
  readonly hasActionableProposedPlan?: boolean;
}

function threadShellSummaryFieldsForEvent(event: OrchestrationEvent): ThreadShellSummaryFields {
  switch (event.type) {
    case "thread.proposed-plan-upserted":
      return { hasActionableProposedPlan: true };

    case "thread.approval-response-requested":
      return { pendingApprovalCount: true };

    case "thread.user-input-response-requested":
      return { pendingUserInputCount: true };

    case "thread.activity-appended":
      return {
        pendingApprovalCount: PENDING_APPROVAL_ACTIVITY_KINDS.has(event.payload.activity.kind),
        pendingUserInputCount: PENDING_USER_INPUT_ACTIVITY_KINDS.has(event.payload.activity.kind),
      };

    default:
      return {};
  }
}

function derivePendingUserInputCountFromActivities(
  activities: ReadonlyArray<ProjectionThreadActivity>,
): number {
  const openRequestIds = new Set<string>();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );

  for (const activity of ordered) {
    const requestId = extractActivityRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;

    if (activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
      continue;
    }

    if (activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      detail !== null &&
      (detail.includes("stale pending user-input request") ||
        detail.includes("unknown pending user-input request") ||
        detail.includes("unknown pending user input request") ||
        detail.includes("unknown pending codex user input request"))
    ) {
      openRequestIds.delete(requestId);
    }
  }

  return openRequestIds.size;
}

function deriveHasActionableProposedPlan(input: {
  readonly latestTurnId: string | null;
  readonly proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>;
}): boolean {
  const sorted = [...input.proposedPlans].toSorted(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.planId.localeCompare(right.planId),
  );

  let latestForTurn: ProjectionThreadProposedPlan | null = null;
  if (input.latestTurnId !== null) {
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const plan = sorted[index];
      if (plan?.turnId === input.latestTurnId) {
        latestForTurn = plan;
        break;
      }
    }
  }
  if (latestForTurn !== null) {
    return latestForTurn.implementedAt === null;
  }

  const latestPlan = sorted.at(-1) ?? null;
  return latestPlan !== null && latestPlan.implementedAt === null;
}

export const makeThreadsProjector = Effect.fn("makeThreadsProjector")(function* () {
  const projectionThreadRepository = yield* ProjectionThreadRepository;
  const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
  const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
  const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
  const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;

  const refreshThreadShellSummary = Effect.fn("refreshThreadShellSummary")(function* (
    threadId: ThreadId,
    fields: ThreadShellSummaryFields,
  ) {
    if (
      !fields.latestUserMessageAt &&
      !fields.pendingApprovalCount &&
      !fields.pendingUserInputCount &&
      !fields.hasActionableProposedPlan
    ) {
      return;
    }

    const existingRow = yield* projectionThreadRepository.getById({
      threadId,
    });
    if (Option.isNone(existingRow)) {
      return;
    }

    let latestUserMessageAt = existingRow.value.latestUserMessageAt;
    if (fields.latestUserMessageAt) {
      const messages = yield* projectionThreadMessageRepository.listByThreadId({ threadId });
      latestUserMessageAt = null;
      for (const message of messages) {
        if (
          message.role === "user" &&
          (latestUserMessageAt === null || message.createdAt > latestUserMessageAt)
        ) {
          latestUserMessageAt = message.createdAt;
        }
      }
    }

    let pendingApprovalCount = existingRow.value.pendingApprovalCount;
    if (fields.pendingApprovalCount) {
      const pendingApprovals = yield* projectionPendingApprovalRepository.listByThreadId({
        threadId,
      });
      pendingApprovalCount = pendingApprovals.filter(
        (approval) => approval.status === "pending",
      ).length;
    }

    let pendingUserInputCount = existingRow.value.pendingUserInputCount;
    if (fields.pendingUserInputCount) {
      const activities = yield* projectionThreadActivityRepository.listByThreadId({ threadId });
      pendingUserInputCount = derivePendingUserInputCountFromActivities(activities);
    }

    let hasActionableProposedPlan = existingRow.value.hasActionableProposedPlan;
    if (fields.hasActionableProposedPlan) {
      const proposedPlans = yield* projectionThreadProposedPlanRepository.listByThreadId({
        threadId,
      });
      hasActionableProposedPlan = deriveHasActionableProposedPlan({
        latestTurnId: existingRow.value.latestTurnId,
        proposedPlans,
      })
        ? 1
        : 0;
    }

    yield* projectionThreadRepository.upsert({
      ...existingRow.value,
      latestUserMessageAt,
      pendingApprovalCount,
      pendingUserInputCount,
      hasActionableProposedPlan,
    });
  });

  const applyThreadShellTouch = Effect.fn("projection.threads:shell-touch")(function* (
    event:
      | EventOf<"thread.proposed-plan-upserted">
      | EventOf<"thread.activity-appended">
      | EventOf<"thread.approval-response-requested">
      | EventOf<"thread.user-input-response-requested">,
  ) {
    const existingRow = yield* projectionThreadRepository.getById({
      threadId: event.payload.threadId,
    });
    if (Option.isNone(existingRow)) {
      return;
    }
    yield* projectionThreadRepository.upsert({
      ...existingRow.value,
      updatedAt: event.occurredAt,
    });
    yield* refreshThreadShellSummary(
      event.payload.threadId,
      threadShellSummaryFieldsForEvent(event),
    );
  });

  const threadsHandlers = {
    "thread.created": Effect.fn("projection.threads:thread.created")(function* (
      event: EventOf<"thread.created">,
    ) {
      yield* projectionThreadRepository.upsert({
        threadId: event.payload.threadId,
        projectId: event.payload.projectId,
        title: event.payload.title,
        modelSelection: event.payload.modelSelection,
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        branch: event.payload.branch,
        worktreePath: event.payload.worktreePath,
        latestTurnId: null,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        titleRegenerationRequestId: null,
        titleRegenerationStartedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });
    }),

    "thread.archived": Effect.fn("projection.threads:thread.archived")(function* (
      event: EventOf<"thread.archived">,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        archivedAt: event.payload.archivedAt,
        titleRegenerationRequestId: null,
        titleRegenerationStartedAt: null,
        updatedAt: event.payload.updatedAt,
      });
    }),

    "thread.unarchived": Effect.fn("projection.threads:thread.unarchived")(function* (
      event: EventOf<"thread.unarchived">,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        archivedAt: null,
        updatedAt: event.payload.updatedAt,
      });
    }),

    "thread.settled": Effect.fn("projection.threads:thread.settled")(function* (
      event: EventOf<"thread.settled">,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        settledOverride: "settled",
        settledAt: event.payload.settledAt,
        updatedAt: event.payload.updatedAt,
      });
    }),

    "thread.unsettled": Effect.fn("projection.threads:thread.unsettled")(function* (
      event: EventOf<"thread.unsettled">,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        settledOverride: event.payload.reason === "user" ? "active" : null,
        settledAt: null,
        updatedAt: event.payload.updatedAt,
      });
    }),

    "thread.snoozed": Effect.fn("projection.threads:thread.snoozed")(function* (
      event: EventOf<"thread.snoozed">,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        snoozedUntil: event.payload.snoozedUntil,
        snoozedAt: event.payload.snoozedAt,
        updatedAt: event.payload.updatedAt,
      });
    }),

    "thread.unsnoozed": Effect.fn("projection.threads:thread.unsnoozed")(function* (
      event: EventOf<"thread.unsnoozed">,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        snoozedUntil: null,
        snoozedAt: null,
        updatedAt: event.payload.updatedAt,
      });
    }),

    "thread.pinned": Effect.fn("projection.threads:thread.pinned")(function* (
      event: EventOf<"thread.pinned">,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        pinnedAt: event.payload.pinnedAt,
        ...(event.payload.pinOrderKey !== undefined
          ? { pinOrderKey: event.payload.pinOrderKey }
          : {}),
        updatedAt: event.payload.updatedAt,
      });
    }),

    "thread.unpinned": Effect.fn("projection.threads:thread.unpinned")(function* (
      event: EventOf<"thread.unpinned">,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        pinnedAt: null,
        pinOrderKey: null,
        updatedAt: event.payload.updatedAt,
      });
    }),

    "thread.pin-reordered": Effect.fn("projection.threads:thread.pin-reordered")(function* (
      event: EventOf<"thread.pin-reordered">,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        pinOrderKey: event.payload.orderKey,
        updatedAt: event.payload.updatedAt,
      });
    }),

    "thread.meta-updated": Effect.fn("projection.threads:thread.meta-updated")(function* (
      event: EventOf<"thread.meta-updated">,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
        ...(event.payload.titleRegeneration !== undefined
          ? {
              titleRegenerationRequestId: event.payload.titleRegeneration?.requestId ?? null,
              titleRegenerationStartedAt: event.payload.titleRegeneration?.startedAt ?? null,
            }
          : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
        ...(event.payload.worktreePath !== undefined
          ? { worktreePath: event.payload.worktreePath }
          : {}),
        updatedAt: event.payload.updatedAt,
      });
    }),

    "thread.runtime-mode-set": Effect.fn("projection.threads:thread.runtime-mode-set")(function* (
      event: EventOf<"thread.runtime-mode-set">,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        runtimeMode: event.payload.runtimeMode,
        updatedAt: event.payload.updatedAt,
      });
    }),

    "thread.interaction-mode-set": Effect.fn("projection.threads:thread.interaction-mode-set")(
      function* (event: EventOf<"thread.interaction-mode-set">) {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.payload.updatedAt,
        });
      },
    ),

    "thread.deleted": Effect.fn("projection.threads:thread.deleted")(function* (
      event: EventOf<"thread.deleted">,
      attachmentSideEffects: AttachmentSideEffects,
    ) {
      attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
      const existingRow = yield* projectionThreadRepository.getById({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        deletedAt: event.payload.deletedAt,
        updatedAt: event.payload.deletedAt,
      });
    }),

    "thread.message-sent": Effect.fn("projection.threads:thread.message-sent")(function* (
      event: EventOf<"thread.message-sent">,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      // Only a user message moves latestUserMessageAt, and messages are
      // append-only outside thread.reverted, so the new timestamp is the
      // running maximum. Assistant text arrives as dozens of streamed
      // deltas per message and must stay free of thread-wide reads.
      const latestUserMessageAt =
        event.payload.role === "user" &&
        (existingRow.value.latestUserMessageAt === null ||
          event.payload.createdAt > existingRow.value.latestUserMessageAt)
          ? event.payload.createdAt
          : existingRow.value.latestUserMessageAt;
      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        latestUserMessageAt,
        updatedAt: event.occurredAt,
      });
    }),

    "thread.proposed-plan-upserted": applyThreadShellTouch,

    "thread.activity-appended": applyThreadShellTouch,

    "thread.approval-response-requested": applyThreadShellTouch,

    "thread.user-input-response-requested": applyThreadShellTouch,

    "thread.session-set": Effect.fn("projection.threads:thread.session-set")(function* (
      event: EventOf<"thread.session-set">,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }
      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        // activeTurnId describes current work; a terminal session must not erase history.
        latestTurnId: event.payload.session.activeTurnId ?? existingRow.value.latestTurnId,
        updatedAt: event.occurredAt,
      });
      // A new latest turn can change which proposed plan is actionable.
      yield* refreshThreadShellSummary(event.payload.threadId, {
        hasActionableProposedPlan: true,
      });
    }),

    "thread.turn-diff-completed": Effect.fn("projection.threads:thread.turn-diff-completed")(
      function* (event: EventOf<"thread.turn-diff-completed">) {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          latestTurnId: event.payload.turnId,
          updatedAt: event.occurredAt,
        });
        yield* refreshThreadShellSummary(event.payload.threadId, {
          hasActionableProposedPlan: true,
        });
      },
    ),

    "thread.reverted": Effect.fn("projection.threads:thread.reverted")(function* (
      event: EventOf<"thread.reverted">,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }

      const retainedTurns = yield* projectionTurnRepository.listByThreadId({
        threadId: event.payload.threadId,
      });
      let latestTurnId: ProjectionTurn["turnId"] = null;
      let latestCheckpointTurnCount = -1;
      for (let index = 0; index < retainedTurns.length; index += 1) {
        const turn = retainedTurns[index];
        if (
          !turn ||
          turn.turnId === null ||
          turn.checkpointTurnCount === null ||
          turn.checkpointTurnCount > event.payload.turnCount
        ) {
          continue;
        }
        if (turn.checkpointTurnCount > latestCheckpointTurnCount) {
          latestCheckpointTurnCount = turn.checkpointTurnCount;
          latestTurnId = turn.turnId;
        }
      }

      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        latestTurnId,
        updatedAt: event.occurredAt,
      });
      // Revert is the one path that removes projected rows, so every
      // summary field has to be re-derived from what survived.
      yield* refreshThreadShellSummary(event.payload.threadId, {
        latestUserMessageAt: true,
        pendingApprovalCount: true,
        pendingUserInputCount: true,
        hasActionableProposedPlan: true,
      });
    }),
  } satisfies ProjectorHandlers;

  return defineProjector({
    name: ORCHESTRATION_PROJECTOR_NAMES.threads,
    // The shell summary counts rows these projections own, so they must
    // have applied this event before it is derived.
    reads: [
      ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
      ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
      ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
      ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
    ],
    on: threadsHandlers,
  });
});
