/**
 * Thread messages projection - one row per message, including streamed
 * assistant text appended delta by delta.
 *
 * @module projectors/threadMessages
 */
import { type ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  type ProjectionThreadMessage,
  ProjectionThreadMessageRepository,
} from "../../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../../persistence/Services/ProjectionTurns.ts";
import {
  attachmentRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../../attachmentStore.ts";
import {
  defineProjector,
  type AttachmentSideEffects,
  type OrchestrationEventOfType as EventOf,
  type ProjectorHandlers,
} from "../ProjectorRegistry.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./names.ts";

const materializeAttachmentsForProjection = Effect.fn("materializeAttachmentsForProjection")(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadMessage> {
  const retainedMessageIds = new Set<string>();
  const retainedTurnIds = new Set<string>();
  const keptTurns = turns.filter(
    (turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount,
  );
  for (const turn of keptTurns) {
    if (turn.turnId !== null) {
      retainedTurnIds.add(turn.turnId);
    }
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

function collectThreadAttachmentRelativePaths(
  threadId: string,
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Set<string> {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return new Set();
  }
  const relativePaths = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachment.id);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        continue;
      }
      relativePaths.add(attachmentRelativePath(attachment));
    }
  }
  return relativePaths;
}

export const makeThreadMessagesProjector = Effect.fn("makeThreadMessagesProjector")(function* () {
  const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;

  const threadMessagesHandlers = {
    "thread.message-sent": Effect.fn("projection.thread-messages:thread.message-sent")(function* (
      event: EventOf<"thread.message-sent">,
    ) {
      const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
        messageId: event.payload.messageId,
      });
      const previousMessage = Option.getOrUndefined(existingMessage);
      const nextText = Option.match(existingMessage, {
        onNone: () => event.payload.text,
        onSome: (message) => {
          if (event.payload.streaming) {
            return `${message.text}${event.payload.text}`;
          }
          if (event.payload.text.length === 0) {
            return message.text;
          }
          return event.payload.text;
        },
      });
      const nextAttachments =
        event.payload.attachments !== undefined
          ? yield* materializeAttachmentsForProjection({
              attachments: event.payload.attachments,
            })
          : previousMessage?.attachments;
      yield* projectionThreadMessageRepository.upsert({
        messageId: event.payload.messageId,
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        role: event.payload.role,
        text: nextText,
        ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
        isStreaming: event.payload.streaming,
        createdAt: previousMessage?.createdAt ?? event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
      });
    }),

    "thread.reverted": Effect.fn("projection.thread-messages:thread.reverted")(function* (
      event: EventOf<"thread.reverted">,
      attachmentSideEffects: AttachmentSideEffects,
    ) {
      const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
        threadId: event.payload.threadId,
      });
      if (existingRows.length === 0) {
        return;
      }

      const existingTurns = yield* projectionTurnRepository.listByThreadId({
        threadId: event.payload.threadId,
      });
      const keptRows = retainProjectionMessagesAfterRevert(
        existingRows,
        existingTurns,
        event.payload.turnCount,
      );
      if (keptRows.length === existingRows.length) {
        return;
      }

      yield* projectionThreadMessageRepository.deleteByThreadId({
        threadId: event.payload.threadId,
      });
      yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert, {
        concurrency: 1,
      }).pipe(Effect.asVoid);
      attachmentSideEffects.prunedThreadRelativePaths.set(
        event.payload.threadId,
        collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
      );
    }),
  } satisfies ProjectorHandlers;

  return defineProjector({
    name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
    reads: [],
    on: threadMessagesHandlers,
  });
});
