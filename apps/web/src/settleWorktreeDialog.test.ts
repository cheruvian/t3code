import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { VcsStatusLocalResult } from "@t3tools/contracts";
import {
  readSettleWorktreeDialog,
  registerSettleWorktreeDialog,
  requestSettleWorktreeDialog,
  respondToSettleWorktreeDialog,
  retrySettleWorktreeDialog,
  setSettleDialogRemoveAutomations,
} from "./settleWorktreeDialog";

const dirtyStatus = {
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: "feature",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [{ path: "changes.txt", insertions: 2, deletions: 1 }],
    insertions: 2,
    deletions: 1,
  },
} satisfies VcsStatusLocalResult;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

describe("settle worktree dialog", () => {
  it("removes automations by default without a worktree and resets an opt-out for the next thread", async () => {
    unregister = registerSettleWorktreeDialog();
    const first = requestSettleWorktreeDialog({ path: null, canDelete: false });
    expect(readSettleWorktreeDialog()?.phase).toBe("ready");
    respondToSettleWorktreeDialog("keep");
    expect(await first).toEqual({ choice: "keep", removeAutomations: true });

    const second = requestSettleWorktreeDialog({ path: null, canDelete: false });
    setSettleDialogRemoveAutomations(false);
    respondToSettleWorktreeDialog("keep");
    expect(await second).toEqual({ choice: "keep", removeAutomations: false });

    const third = requestSettleWorktreeDialog({ path: null, canDelete: false });
    expect(readSettleWorktreeDialog()?.removeAutomations).toBe(true);
    respondToSettleWorktreeDialog(null);
    expect(await third).toBeNull();
  });
  it("opens before the detail request completes and accepts deletion only after review", async () => {
    unregister = registerSettleWorktreeDialog();
    const status = deferred<VcsStatusLocalResult>();
    const choice = requestSettleWorktreeDialog({
      path: "/worktree",
      canDelete: true,
      loadStatus: () => status.promise,
    });

    expect(readSettleWorktreeDialog()).toMatchObject({ phase: "loading", status: null });
    respondToSettleWorktreeDialog("delete");
    expect(readSettleWorktreeDialog()?.phase).toBe("loading");

    status.resolve(dirtyStatus);
    await status.promise;
    await vi.waitFor(() => expect(readSettleWorktreeDialog()?.phase).toBe("ready"));
    respondToSettleWorktreeDialog("delete");
    expect(await choice).toEqual({
      choice: "delete",
      status: dirtyStatus,
      removeAutomations: true,
    });
  });

  it("shows a recoverable error and ignores a late result after cancellation", async () => {
    unregister = registerSettleWorktreeDialog();
    const first = deferred<VcsStatusLocalResult>();
    const second = deferred<VcsStatusLocalResult>();
    const loadStatus = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const choice = requestSettleWorktreeDialog({ path: "/worktree", canDelete: true, loadStatus });

    first.reject(new Error("Git status failed"));
    await vi.waitFor(() => expect(readSettleWorktreeDialog()?.phase).toBe("error"));
    respondToSettleWorktreeDialog("delete");
    expect(readSettleWorktreeDialog()?.phase).toBe("error");

    retrySettleWorktreeDialog();
    expect(readSettleWorktreeDialog()?.phase).toBe("loading");
    respondToSettleWorktreeDialog(null);
    expect(await choice).toBeNull();
    second.resolve(dirtyStatus);
    await second.promise;
    expect(readSettleWorktreeDialog()).toBeNull();
  });

  it("settles while keeping a worktree even when its changed files cannot load", async () => {
    unregister = registerSettleWorktreeDialog();
    const status = deferred<VcsStatusLocalResult>();
    const choice = requestSettleWorktreeDialog({
      path: "/worktree",
      canDelete: true,
      loadStatus: () => status.promise,
    });

    respondToSettleWorktreeDialog("keep");
    expect(await choice).toEqual({ choice: "keep", removeAutomations: true });
    expect(readSettleWorktreeDialog()).toBeNull();

    status.reject(new Error("Git status failed"));
    await expect(status.promise).rejects.toThrow("Git status failed");
    expect(readSettleWorktreeDialog()).toBeNull();
  });

  it("keeps a clean worktree open for an explicit keep or delete decision", async () => {
    unregister = registerSettleWorktreeDialog();
    const cleanStatus = {
      ...dirtyStatus,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    };
    const choice = requestSettleWorktreeDialog({
      path: "/worktree",
      canDelete: true,
      loadStatus: async () => cleanStatus,
    });
    await vi.waitFor(() => expect(readSettleWorktreeDialog()?.phase).toBe("ready"));
    expect(readSettleWorktreeDialog()?.status).toEqual(cleanStatus);
    respondToSettleWorktreeDialog("delete");
    expect(await choice).toEqual({
      choice: "delete",
      status: cleanStatus,
      removeAutomations: true,
    });
  });

  it("keeps a shared clean worktree when deletion is unavailable", async () => {
    unregister = registerSettleWorktreeDialog();
    const choice = requestSettleWorktreeDialog({
      path: "/worktree",
      canDelete: false,
      initialStatus: { ...dirtyStatus, hasWorkingTreeChanges: false },
      loadStatus: async () => dirtyStatus,
    });
    respondToSettleWorktreeDialog("delete");
    expect(readSettleWorktreeDialog()).not.toBeNull();
    respondToSettleWorktreeDialog("keep");
    expect(await choice).toEqual({ choice: "keep", removeAutomations: true });
  });
});
