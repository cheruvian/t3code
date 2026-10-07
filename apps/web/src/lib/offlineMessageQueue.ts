import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  ProjectId,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  OrchestrationMessageContext,
  ChatAttachment,
  UploadChatAttachment,
} from "@t3tools/contracts";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import * as Schema from "effect/Schema";

const CreateThread = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
const QueuedInput = Schema.Struct({
  commandId: CommandId,
  createdAt: Schema.String,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(Schema.Union([ChatAttachment, UploadChatAttachment])),
    context: Schema.optionalKey(OrchestrationMessageContext),
  }),
  modelSelection: Schema.optionalKey(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  dispatchMode: Schema.Literal("queue"),
  bootstrap: Schema.optionalKey(
    Schema.Struct({
      createThread: Schema.optionalKey(CreateThread),
      prepareWorktree: Schema.optionalKey(
        Schema.Struct({
          projectCwd: Schema.String,
          baseBranch: Schema.String,
          requireWorktree: Schema.optionalKey(Schema.Boolean),
          startFromOrigin: Schema.optionalKey(Schema.Boolean),
        }),
      ),
      runSetupScript: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export const OfflineMessage = Schema.Struct({
  environmentId: EnvironmentId,
  ownerThreadId: ThreadId,
  input: QueuedInput,
  attachments: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      type: Schema.Literals(["image", "file"]),
      name: Schema.String,
      mimeType: Schema.String,
      sizeBytes: Schema.Number,
      file: Schema.NullOr(Schema.instanceOf(Blob)),
      uploadedAttachmentId: Schema.optionalKey(Schema.String),
    }),
  ),
  error: Schema.optionalKey(Schema.String),
});
export type OfflineMessage = typeof OfflineMessage.Type;
const decodeMessage = Schema.decodeUnknownSync(OfflineMessage);

export interface OfflineMessageStorage {
  load: () => Promise<ReadonlyArray<OfflineMessage>>;
  put: (message: OfflineMessage) => Promise<void>;
  putAll: (messages: ReadonlyArray<OfflineMessage>) => Promise<void>;
  remove: (messageId: MessageId, replacement?: OfflineMessage) => Promise<void>;
}

/** IndexedDB retains attachment bytes together with the command's stable identity. */
export function createOfflineMessageStorage(): OfflineMessageStorage {
  let database: Promise<IDBDatabase> | undefined;
  const open = () =>
    (database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("t3code:offline-messages", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("messages", { keyPath: "input.message.messageId" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
    }));
  const mutate = async (write: (store: IDBObjectStore) => void) => {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("messages", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      write(transaction.objectStore("messages"));
    });
  };
  return {
    load: async () => {
      const db = await open();
      const records = await new Promise<ReadonlyArray<unknown>>((resolve, reject) => {
        const request = db.transaction("messages").objectStore("messages").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return records
        .map((record) => decodeMessage(record))
        .sort((a, b) => a.input.createdAt.localeCompare(b.input.createdAt));
    },
    put: (message) => mutate((store) => store.put(message)),
    putAll: (messages) =>
      mutate((store) => {
        for (const message of messages) store.put(message);
      }),
    remove: (messageId, replacement) =>
      mutate((store) => {
        if (replacement) store.put(replacement);
        store.delete(messageId);
      }),
  };
}

export type OfflineDeliveryResult =
  | { status: "sent" }
  | { status: "retry" }
  | { status: "failed"; error: string };

/** One drain per environment; durable command IDs make uncertain acknowledgements retryable. */
export function createOfflineMessageQueue(storage: OfflineMessageStorage) {
  let messages: ReadonlyArray<OfflineMessage> = [];
  const listeners = new Set<() => void>();
  const active = new Set<EnvironmentId>();
  const sending = new Set<MessageId>();
  const cancelling = new Set<MessageId>();
  let writes = Promise.resolve();
  let loading: Promise<void> | undefined;
  const publish = () => {
    messages = [...messages];
    for (const listener of listeners) listener();
  };
  const serialize = <A>(work: () => Promise<A>): Promise<A> => {
    const result = writes.then(work, work);
    writes = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const load = () =>
    (loading ??= serialize(async () => {
      messages = await storage.load();
      publish();
    }).catch((error) => {
      loading = undefined;
      throw error;
    }));
  const enqueueAll = async (queued: ReadonlyArray<OfflineMessage>) => {
    await load();
    await serialize(async () => {
      await storage.putAll(queued);
      const ids = new Set(queued.map((x) => x.input.message.messageId));
      messages = [...messages.filter((x) => !ids.has(x.input.message.messageId)), ...queued].sort(
        (a, b) => a.input.createdAt.localeCompare(b.input.createdAt),
      );
      publish();
    });
  };
  const enqueue = (message: OfflineMessage) => enqueueAll([message]);
  const remove = async (id: MessageId) => {
    if (sending.has(id))
      throw new Error("This message is being delivered. Wait for delivery to finish.");
    cancelling.add(id);
    try {
      await serialize(async () => {
        const removed = messages.find((x) => x.input.message.messageId === id);
        const next = removed?.input.bootstrap?.createThread
          ? messages.find(
              (x) =>
                x.environmentId === removed.environmentId &&
                x.input.threadId === removed.input.threadId &&
                x.input.message.messageId !== id,
            )
          : undefined;
        // Remaining messages still need the initial thread/worktree creation when the first was cancelled.
        const replacement =
          next && removed?.input.bootstrap
            ? { ...next, input: { ...next.input, bootstrap: removed.input.bootstrap } }
            : undefined;
        await storage.remove(id, replacement);
        messages = messages
          .filter((x) => x.input.message.messageId !== id)
          .map((x) =>
            replacement && x.input.message.messageId === replacement.input.message.messageId
              ? replacement
              : x,
          );
        publish();
      });
    } finally {
      cancelling.delete(id);
    }
  };
  const retry = async (id: MessageId) => {
    await serialize(async () => {
      const current = messages.find((x) => x.input.message.messageId === id);
      if (!current || sending.has(id)) return;
      const { error: _, ...next } = current;
      await storage.put(next);
      messages = messages.map((x) => (x === current ? next : x));
      publish();
    });
  };
  const drain = async (
    environmentId: EnvironmentId,
    connected: () => boolean,
    deliver: (message: OfflineMessage) => Promise<OfflineDeliveryResult>,
  ) => {
    await load();
    if (active.has(environmentId)) return;
    active.add(environmentId);
    try {
      // Re-read under the browser lock so another tab's acknowledged messages stay removed.
      await serialize(async () => {
        messages = await storage.load();
        publish();
      });
      const blockedThreads = new Set<ThreadId>();
      for (const queued of messages.filter((x) => x.environmentId === environmentId)) {
        if (!connected()) break;
        const message = messages.find(
          (x) => x.input.message.messageId === queued.input.message.messageId,
        );
        if (!message) continue;
        if (message.error || blockedThreads.has(message.input.threadId)) {
          blockedThreads.add(message.input.threadId);
          continue;
        }
        const id = message.input.message.messageId;
        if (cancelling.has(id) || !messages.some((x) => x.input.message.messageId === id)) continue;
        sending.add(id);
        publish();
        try {
          const result = await deliver(message);
          if (result.status === "retry") break;
          if (result.status === "sent") {
            await serialize(async () => {
              await storage.remove(id);
              messages = messages.filter((x) => x.input.message.messageId !== id);
              publish();
            });
          } else {
            const current = messages.find((x) => x.input.message.messageId === id) ?? message;
            const failed = { ...current, error: result.error };
            await serialize(async () => {
              await storage.put(failed);
              messages = messages.map((x) => (x.input.message.messageId === id ? failed : x));
              publish();
            });
            blockedThreads.add(message.input.threadId);
          }
        } finally {
          sending.delete(id);
          publish();
        }
      }
    } finally {
      active.delete(environmentId);
    }
  };
  return {
    load,
    enqueue,
    enqueueAll,
    remove,
    retry,
    drain,
    getSnapshot: () => messages,
    isSending: (id: MessageId) => sending.has(id),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Compile-time check: stored turns remain valid inputs for the ordinary send path. */
export const offlineTurnInput = (message: OfflineMessage): StartThreadTurnInput => message.input;
