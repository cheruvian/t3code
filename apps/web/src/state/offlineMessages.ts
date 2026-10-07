import {
  createOfflineMessageQueue,
  createOfflineMessageStorage,
  type OfflineMessage,
} from "../lib/offlineMessageQueue";
import { useSyncExternalStore } from "react";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { threadEnvironment } from "./threads";
import { serverEnvironment } from "./server";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import type { EnvironmentId } from "@t3tools/contracts";
import { environmentPresentations } from "./presentation";
import {
  startAttachmentUpload,
  awaitAttachmentUploads,
  getUploadedAttachments,
} from "../lib/attachmentUploadQueue";
import type { ComposerImageAttachment, ComposerFileAttachment } from "../composerDraftStore";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";

export const offlineMessages = createOfflineMessageQueue(createOfflineMessageStorage());
export const useOfflineMessages = () =>
  useSyncExternalStore(offlineMessages.subscribe, offlineMessages.getSnapshot);

export function offlineEnvironmentConnected(environmentId: EnvironmentId): boolean {
  const presentation = appAtomRegistry.get(
    environmentPresentations.presentationAtom(environmentId),
  );
  return presentation?.entry.enabled === true && presentation.connection.phase === "connected";
}

function retryable(error: unknown): boolean {
  if (!(error instanceof Object) || !("_tag" in error)) return false;
  return [
    "RpcClientError",
    "EnvironmentRpcUnavailableError",
    "ConnectionTransientError",
    "RemoteEnvironmentAuthTimeoutError",
  ].includes(String(error._tag));
}

const readBlob = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Could not read queued attachment."));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

async function deliver(message: OfflineMessage) {
  let input = message.input;
  if (message.attachments.length > 0 && input.message.attachments.length === 0) {
    const config = appAtomRegistry.get(serverEnvironment.configValueAtom(message.environmentId));
    const localAttachments = message.attachments.map(
      (attachment): ComposerImageAttachment | ComposerFileAttachment => {
        const file =
          attachment.file === null
            ? null
            : new File([attachment.file], attachment.name, { type: attachment.mimeType });
        if (attachment.type === "image") {
          if (!file) throw new Error("The queued image is missing its bytes.");
          return { ...attachment, type: "image", file, previewUrl: "" };
        }
        return {
          ...attachment,
          type: "file",
          file,
          ...(attachment.uploadedAttachmentId
            ? { uploadEnvironmentId: message.environmentId }
            : {}),
        };
      },
    );
    let attachments;
    if (config?.environment.capabilities.attachmentUploads === true) {
      for (const image of localAttachments)
        startAttachmentUpload({ environmentId: message.environmentId, image });
      await awaitAttachmentUploads(localAttachments.map((x) => x.id));
      attachments = getUploadedAttachments({
        environmentId: message.environmentId,
        images: localAttachments,
      });
      if (attachments === null) return { status: "retry" as const };
    } else {
      attachments = await Promise.all(
        message.attachments.map(async (attachment) => {
          if (attachment.type !== "image" || !attachment.file)
            throw new Error("This server cannot accept the queued file attachment.");
          return {
            type: "image" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            dataUrl: await readBlob(attachment.file),
          };
        }),
      );
    }
    const context = remapComposerContextAttachments(
      input.message.context,
      message.attachments,
      attachments,
    );
    input = {
      ...input,
      message: { ...input.message, attachments, ...(context ? { context } : {}) },
    };
    // Keep the uploaded IDs stable if the socket drops after server acceptance.
    await offlineMessages.enqueue({ ...message, input });
  }
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(message.environmentId));
  const context = input.message.context;
  const { context: _context, ...plainMessage } = input.message;
  const outgoing =
    context && config?.environment.capabilities.inlineMessageContext !== true
      ? {
          ...input,
          message: {
            ...plainMessage,
            text: serializeLegacyContextMessage({
              text: input.message.text,
              records: context.records,
            }),
          },
        }
      : input;
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.startTurn,
    { environmentId: message.environmentId, input: outgoing },
    { reportFailure: false },
  );
  if (result._tag === "Success") return { status: "sent" as const };
  const error = squashAtomCommandFailure(result);
  return retryable(error)
    ? { status: "retry" as const }
    : { status: "failed" as const, error: error instanceof Error ? error.message : String(error) };
}

export async function drainOfflineMessages(environmentId: EnvironmentId) {
  const drain = () =>
    offlineMessages.drain(
      environmentId,
      () => offlineEnvironmentConnected(environmentId),
      async (message) => {
        try {
          return await deliver(message);
        } catch (error) {
          return !offlineEnvironmentConnected(environmentId) || retryable(error)
            ? { status: "retry" }
            : { status: "failed", error: error instanceof Error ? error.message : String(error) };
        }
      },
    );
  if (typeof navigator !== "undefined" && navigator.locks) {
    await navigator.locks.request(
      `t3code:offline-messages:${environmentId}`,
      { ifAvailable: true },
      (lock) => (lock ? drain() : undefined),
    );
  } else {
    await drain();
  }
}
