import { describe, expect, it, vi } from "vite-plus/test";

import {
  EnvironmentId,
  type PreviewViewportSetting,
  ThreadId,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  resize: Symbol("preview-resize"),
  serverEpoch: "server-a",
  runAtomCommand: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { resize: mocks.resize } }));
vi.mock("~/previewStateStore", () => ({
  updatePreviewServerSnapshot: mocks.updatePreviewServerSnapshot,
  readThreadPreviewState: () => ({ serverEpoch: mocks.serverEpoch }),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { commitBrowserViewportChange, queueBrowserViewportCommit } from "./browserViewportActions";

describe("browserViewportActions", () => {
  it("commits viewport changes in order for each tab", async () => {
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const calls: Array<number> = [];
    const resize = async (setting: PreviewViewportSetting) => {
      if (setting._tag === "fill") return;
      calls.push(setting.width);
      if (setting.width === 800) {
        markFirstStarted?.();
        await firstPending;
      }
    };

    const first = queueBrowserViewportCommit("tab-serial", () =>
      resize({ _tag: "freeform", width: 800, height: 600 }),
    );
    const second = queueBrowserViewportCommit("tab-serial", () =>
      resize({ _tag: "freeform", width: 900, height: 700 }),
    );
    await firstStarted;
    expect(calls).toEqual([800]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(calls).toEqual([800, 900]);
  });

  it("resizes a tab that no preview panel is showing", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
    };
    const snapshot = { tabId: "tab-1" } as PreviewSessionSnapshot;
    mocks.runAtomCommand.mockResolvedValueOnce({ _tag: "Success", value: snapshot });
    const viewport: PreviewViewportSetting = { _tag: "freeform", width: 390, height: 844 };

    await commitBrowserViewportChange(
      { threadRef, tabId: "tab-1", runtimeTabId: "runtime-tab-1" },
      viewport,
    );

    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.resize,
      {
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, tabId: "tab-1", viewport },
      },
      expect.anything(),
    );
    expect(mocks.updatePreviewServerSnapshot).toHaveBeenCalledWith(threadRef, snapshot);
  });
});

it("does not publish a resize response from a replaced server", async () => {
  mocks.serverEpoch = "server-a";
  mocks.updatePreviewServerSnapshot.mockClear();
  let resolve!: (result: unknown) => void;
  let started!: () => void;
  const start = new Promise<void>((done) => {
    started = done;
  });
  mocks.runAtomCommand.mockImplementationOnce(() => {
    started();
    return new Promise((done) => {
      resolve = done;
    });
  });
  const resizing = commitBrowserViewportChange(
    {
      threadRef: {
        environmentId: EnvironmentId.make("env-stale"),
        threadId: ThreadId.make("thread-stale"),
      },
      tabId: "stale-tab",
      runtimeTabId: "stale-runtime",
    },
    { _tag: "freeform", width: 800, height: 600 },
  );
  await start;
  mocks.serverEpoch = "server-b";
  resolve({ _tag: "Success", value: { tabId: "stale-tab" } });
  await resizing;
  expect(mocks.updatePreviewServerSnapshot).not.toHaveBeenCalled();
});

it("keeps a timed-out resize ahead of a newer resize until the real operation finishes", async () => {
  vi.useFakeTimers();
  try {
    let release!: () => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const order: string[] = [];
    const first = queueBrowserViewportCommit("timeout-order", async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("first settled");
    });
    const failure = first.catch((error: Error) => error.message);
    await firstStarted;
    const second = queueBrowserViewportCommit("timeout-order", async () => {
      order.push("newer resize");
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await failure).toContain("Timed out committing");
    expect(order).toEqual([]);
    release();
    await second;
    expect(order).toEqual(["first settled", "newer resize"]);
  } finally {
    vi.useRealTimers();
  }
});
