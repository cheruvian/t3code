import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { VcsStatusLocalResult } from "@t3tools/contracts";
import {
  readSettleWorktreeDialog,
  registerSettleWorktreeDialog,
  requestSettleWorktreeDialog,
  respondToSettleWorktreeDialog,
  retrySettleWorktreeDialog,
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
    expect(await choice).toEqual({ choice: "delete", status: dirtyStatus });
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
    respondToSettleWorktreeDialog("keep");
    expect(readSettleWorktreeDialog()?.phase).toBe("error");

    retrySettleWorktreeDialog();
    expect(readSettleWorktreeDialog()?.phase).toBe("loading");
    respondToSettleWorktreeDialog(null);
    expect(await choice).toBeNull();
    second.resolve(dirtyStatus);
    await second.promise;
    expect(readSettleWorktreeDialog()).toBeNull();
  });

  it("dismisses the prompt if the worktree became clean while details loaded", async () => {
    unregister = registerSettleWorktreeDialog();
    const choice = requestSettleWorktreeDialog({
      path: "/worktree",
      canDelete: true,
      loadStatus: async () => ({ ...dirtyStatus, hasWorkingTreeChanges: false }),
    });
    expect(await choice).toEqual({ choice: "clean" });
    expect(readSettleWorktreeDialog()).toBeNull();
  });
});
