import { describe, expect, it } from "vite-plus/test";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ProviderInstanceId, ProjectId } from "@t3tools/contracts";
import {
  createOfflineMessageQueue,
  type OfflineMessage,
  type OfflineMessageStorage,
} from "./offlineMessageQueue";

const env = EnvironmentId.make("offline-test");
const thread = ThreadId.make("thread-1");
function message(id: string, overrides: Partial<OfflineMessage> = {}): OfflineMessage {
  return {
    environmentId: env,
    ownerThreadId: thread,
    attachments: [],
    input: {
      threadId: thread,
      commandId: CommandId.make(`offline:${id}`),
      createdAt: `2026-10-06T12:00:0${id.slice(-1)}.000Z`,
      message: { messageId: MessageId.make(id), role: "user", text: id, attachments: [] },
      runtimeMode: "full-access",
      interactionMode: "default",
      dispatchMode: "queue",
    },
    ...overrides,
  };
}
function memoryStorage() {
  const records = new Map<MessageId, OfflineMessage>();
  const storage: OfflineMessageStorage = {
    load: async () => [...records.values()].map((x) => structuredClone(x)),
    put: async (x) => {
      records.set(x.input.message.messageId, structuredClone(x));
    },
    putAll: async (xs) => {
      for (const x of xs) records.set(x.input.message.messageId, structuredClone(x));
    },
    remove: async (id, replacement) => {
      if (replacement)
        records.set(replacement.input.message.messageId, structuredClone(replacement));
      records.delete(id);
    },
  };
  return { records, storage };
}
function deferred<A>() {
  let resolve: (value: A) => void = () => {};
  const promise = new Promise<A>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("offline message delivery", () => {
  it("persists text and attachment bytes across reload and waits for a connection", async () => {
    const { storage } = memoryStorage();
    const queue = createOfflineMessageQueue(storage);
    await queue.enqueue(
      message("message-1", {
        attachments: [
          {
            id: "file-1",
            type: "file",
            name: "note.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
            file: new Blob(["hello"]),
          },
        ],
      }),
    );
    const reloaded = createOfflineMessageQueue(storage);
    let sent = 0;
    await reloaded.drain(
      env,
      () => false,
      async () => {
        sent++;
        return { status: "sent" };
      },
    );
    expect(sent).toBe(0);
    expect(await reloaded.getSnapshot()[0]!.attachments[0]!.file!.text()).toBe("hello");
    await reloaded.drain(
      env,
      () => true,
      async () => {
        sent++;
        return { status: "sent" };
      },
    );
    expect(sent).toBe(1);
    expect(await storage.load()).toEqual([]);
  });
  it("serializes delivery and retains stable identity after an uncertain acknowledgement", async () => {
    const { storage } = memoryStorage();
    const queue = createOfflineMessageQueue(storage);
    await queue.enqueueAll([message("message-1"), message("message-2")]);
    const started = deferred<void>();
    const release = deferred<void>();
    const sent: string[] = [];
    const accepted = new Set<string>();
    const first = queue.drain(
      env,
      () => true,
      async (item) => {
        sent.push(item.input.commandId);
        accepted.add(item.input.commandId);
        started.resolve();
        await release.promise;
        return { status: "retry" };
      },
    );
    await started.promise;
    await queue.drain(
      env,
      () => true,
      async () => {
        throw new Error("Concurrent drain dispatched");
      },
    );
    expect(sent).toHaveLength(1);
    expect(queue.isSending(MessageId.make("message-1"))).toBe(true);
    await expect(queue.remove(MessageId.make("message-1"))).rejects.toThrow("being delivered");
    release.resolve();
    await first;
    await queue.drain(
      env,
      () => true,
      async (item) => {
        sent.push(item.input.commandId);
        accepted.add(item.input.commandId);
        return { status: "sent" };
      },
    );
    expect(sent).toEqual(["offline:message-1", "offline:message-1", "offline:message-2"]);
    expect(accepted.size).toBe(2);
    expect(await storage.load()).toEqual([]);
  });
  it("does not send a cancelled successor from an older drain snapshot", async () => {
    const { storage } = memoryStorage();
    const queue = createOfflineMessageQueue(storage);
    await queue.enqueueAll([message("message-1"), message("message-2")]);
    const started = deferred<void>();
    const release = deferred<void>();
    const sent: string[] = [];
    const drain = queue.drain(
      env,
      () => true,
      async (item) => {
        sent.push(item.input.message.messageId);
        started.resolve();
        await release.promise;
        return { status: "sent" };
      },
    );
    await started.promise;
    await queue.remove(MessageId.make("message-2"));
    release.resolve();
    await drain;
    expect(sent).toEqual(["message-1"]);
  });
  it("preserves a failed message, blocks its successors, and still delivers another thread", async () => {
    const { storage } = memoryStorage();
    const queue = createOfflineMessageQueue(storage);
    const other = message("message-3");
    await queue.enqueueAll([
      message("message-1"),
      message("message-2"),
      { ...other, input: { ...other.input, threadId: ThreadId.make("thread-2") } },
    ]);
    const sent: string[] = [];
    await queue.drain(
      env,
      () => true,
      async (item) => {
        sent.push(item.input.message.messageId);
        return item.input.message.messageId === "message-1"
          ? { status: "failed", error: "Provider unavailable" }
          : { status: "sent" };
      },
    );
    expect(sent).toEqual(["message-1", "message-3"]);
    expect(queue.getSnapshot()[0]!.error).toBe("Provider unavailable");
    await queue.retry(MessageId.make("message-1"));
    await queue.drain(
      env,
      () => true,
      async () => ({ status: "sent" }),
    );
    expect(queue.getSnapshot()).toEqual([]);
  });
  it("keeps new-thread creation with the next message when its first message is cancelled", async () => {
    const { storage } = memoryStorage();
    const queue = createOfflineMessageQueue(storage);
    const first = message("message-1");
    const bootstrap = {
      createThread: {
        projectId: ProjectId.make("project-1"),
        title: "New thread",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-test"),
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        createdAt: first.input.createdAt,
      },
    };
    await queue.enqueueAll([
      { ...first, input: { ...first.input, bootstrap } },
      message("message-2"),
    ]);
    await queue.remove(first.input.message.messageId);
    const reloaded = createOfflineMessageQueue(storage);
    await reloaded.load();
    expect(reloaded.getSnapshot()).toHaveLength(1);
    expect(reloaded.getSnapshot()[0]!.input.bootstrap).toEqual(bootstrap);
  });
  it("keeps prepared attachments when delivery fails after upload", async () => {
    const { storage } = memoryStorage();
    const queue = createOfflineMessageQueue(storage);
    await queue.enqueue(message("message-1"));
    await queue.drain(
      env,
      () => true,
      async (item) => {
        await queue.enqueue({
          ...item,
          input: {
            ...item.input,
            message: {
              ...item.input.message,
              attachments: [
                {
                  type: "file",
                  id: "uploaded-1",
                  name: "note.txt",
                  mimeType: "text/plain",
                  sizeBytes: 5,
                },
              ],
            },
          },
        });
        return { status: "failed", error: "Provider unavailable" };
      },
    );
    expect(queue.getSnapshot()[0]!.input.message.attachments[0]!.id).toBe("uploaded-1");
    expect((await storage.load())[0]!.error).toBe("Provider unavailable");
  });
  it("does not publish or accept a message if durable storage fails", async () => {
    const { storage } = memoryStorage();
    const queue = createOfflineMessageQueue({
      ...storage,
      putAll: async () => {
        throw new Error("Quota exceeded");
      },
    });
    await expect(queue.enqueue(message("message-1"))).rejects.toThrow("Quota exceeded");
    expect(queue.getSnapshot()).toEqual([]);
    expect(await storage.load()).toEqual([]);
  });
});
