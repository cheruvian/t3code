import {
  EventId,
  OrchestrationV2DomainEventJson,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type ProjectId,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface ThreadMoveHistoryDestination {
  readonly moveId: string;
  readonly sourceEnvironmentId?: EnvironmentId;
  readonly projectId: ProjectId;
  readonly instanceId: ProviderInstanceId;
  readonly sourceInstanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly branch: string | null;
  readonly providerThread: OrchestrationV2ProviderThread;
}

/** Replays conversation history without importing process ownership or scheduling work. */
export function rehomeThreadMoveHistory(
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  destination: ThreadMoveHistoryDestination,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const encode = Schema.encodeSync(OrchestrationV2DomainEventJson);
  const decode = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
  return events.flatMap((event) => {
    // Move lifecycle belongs to the source. A destination starts with no fence.
    if (
      event.type.startsWith("thread.move.") ||
      event.type === "thread.moved" ||
      event.type === "thread.settled" ||
      event.type === "thread.unsettled" ||
      event.type === "thread.visited" ||
      event.type === "thread.marked-unread"
    )
      return [];
    const encoded = encode(event);
    const payload: Record<string, unknown> = { ...encoded.payload };
    if (event.type.startsWith("thread.")) {
      Object.assign(payload, {
        projectId: destination.projectId,
        providerInstanceId: destination.instanceId,
        modelSelection: {
          ...(payload["modelSelection"] as Record<string, unknown>),
          instanceId: destination.instanceId,
        },
        worktreePath: destination.cwd,
        branch: destination.branch,
        historyOrigin: payload["historyOrigin"] ?? "native",
        environmentMove: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
        ...(destination.sourceEnvironmentId
          ? {
              environmentMoveOrigin: {
                moveId: destination.moveId,
                sourceEnvironmentId: destination.sourceEnvironmentId,
              },
            }
          : {}),
        activeProviderThreadId: destination.providerThread.id,
        archivedAt: null,
        deletedAt: null,
        titleRegeneration: null,
        limitRecovery: null,
      });
    }
    if (event.type === "provider-session.attached" || event.type === "provider-session.updated") {
      // These are historical records, never live runtimes on the destination.
      payload["id"] = `move:${destination.moveId}:${String(payload["id"])}`;
      payload["status"] = "stopped";
      payload["cwd"] = destination.cwd;
      if (payload["providerInstanceId"] === destination.sourceInstanceId)
        payload["providerInstanceId"] = destination.instanceId;
    }
    if (event.type === "provider-session.detached") {
      payload["providerSessionId"] =
        `move:${destination.moveId}:${String(payload["providerSessionId"])}`;
    }
    if (event.type === "provider-thread.updated") {
      if (payload["providerInstanceId"] === destination.sourceInstanceId)
        payload["providerInstanceId"] = destination.instanceId;
      payload["providerSessionId"] = null;
      payload["pendingBackgroundTasks"] = [];
      payload["status"] = "not_loaded";
      if (payload["id"] === destination.providerThread.id) {
        if (payload["providerInstanceId"] === destination.sourceInstanceId)
          payload["providerInstanceId"] = destination.instanceId;
        payload["nativeThreadRef"] = destination.providerThread.nativeThreadRef;
        payload["nativeMetadata"] = destination.providerThread.nativeMetadata;
      } else {
        // Native files for previous provider threads are not in this archive.
        payload["nativeThreadRef"] = null;
        payload["nativeConversationHeadRef"] = null;
        payload["status"] = "closed";
      }
    }
    if (event.type === "run.created" || event.type === "run.updated") {
      if (payload["providerInstanceId"] === destination.sourceInstanceId)
        payload["providerInstanceId"] = destination.instanceId;
      const modelSelection = payload["modelSelection"] as Record<string, unknown>;
      if (modelSelection["instanceId"] === destination.sourceInstanceId)
        payload["modelSelection"] = { ...modelSelection, instanceId: destination.instanceId };
      if (
        ["preparing", "queued", "starting", "running", "waiting"].includes(
          String(payload["status"]),
        )
      ) {
        payload["status"] = "interrupted";
        payload["activeAttemptId"] = null;
        payload["queuePosition"] = null;
        payload["completedAt"] = payload["completedAt"] ?? encoded.occurredAt;
      }
    }
    if (event.type === "run-attempt.created" || event.type === "run-attempt.updated") {
      if (payload["providerInstanceId"] === destination.sourceInstanceId)
        payload["providerInstanceId"] = destination.instanceId;
      if (["pending", "running"].includes(String(payload["status"]))) {
        payload["status"] = "interrupted";
        payload["completedAt"] = payload["completedAt"] ?? encoded.occurredAt;
      }
    }
    if (event.type === "provider-turn.updated") {
      if (["pending", "running"].includes(String(payload["status"]))) {
        payload["status"] = "interrupted";
        payload["completedAt"] = payload["completedAt"] ?? encoded.occurredAt;
      }
      if (payload["providerThreadId"] !== destination.providerThread.id) {
        payload["nativeTurnRef"] = null;
      }
    }
    if (event.type === "runtime-request.updated" && payload["status"] === "pending") {
      payload["status"] = "cancelled";
      payload["resolvedAt"] = encoded.occurredAt;
      payload["responseCapability"] = {
        type: "not_resumable",
        reason: "The request belonged to the source environment.",
      };
    }
    if (
      event.type === "node.updated" &&
      ["pending", "running", "waiting"].includes(String(payload["status"]))
    ) {
      payload["status"] = "interrupted";
      payload["completedAt"] = payload["completedAt"] ?? encoded.occurredAt;
    }
    if (event.type === "message.updated") payload["streaming"] = false;
    if (event.type === "checkpoint-scope.created") payload["cwd"] = destination.cwd;
    return [
      decode({ ...encoded, id: EventId.make(`move:${destination.moveId}:${event.id}`), payload }),
    ];
  });
}
