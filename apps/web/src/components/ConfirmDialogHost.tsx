import { useEffect, useSyncExternalStore } from "react";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  respondToConfirmDialog,
  subscribeConfirmDialog,
} from "../confirmDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import {
  readSettleWorktreeDialog,
  registerSettleWorktreeDialog,
  respondToSettleWorktreeDialog,
  retrySettleWorktreeDialog,
  subscribeSettleWorktreeDialog,
} from "../settleWorktreeDialog";

const SETTLE_WORKTREE_VISIBLE_FILES = 100;

type ConfirmationCopy = {
  readonly title: string;
  readonly description: string | null;
};

function resolveConfirmDialogCopy(message: string): ConfirmationCopy {
  const normalizedMessage = message.trim();
  const lines = normalizedMessage.split("\n");
  const questionLineIndex = lines.findIndex((line) => line.trim().endsWith("?"));

  if (questionLineIndex >= 0) {
    const title = lines[questionLineIndex]!.trim();
    const description = lines
      .filter((_, index) => index !== questionLineIndex)
      .join("\n")
      .trim();
    return { title, description: description || null };
  }

  const questionMarkIndex = normalizedMessage.indexOf("?");
  if (questionMarkIndex >= 0) {
    return {
      title: normalizedMessage.slice(0, questionMarkIndex + 1).trim(),
      description: normalizedMessage.slice(questionMarkIndex + 1).trim() || null,
    };
  }

  return {
    title: "Confirm action",
    description: normalizedMessage || "This action requires your confirmation.",
  };
}

export function ConfirmDialogHost() {
  const state = useSyncExternalStore(
    subscribeConfirmDialog,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  useEffect(() => registerConfirmDialogHost(), []);
  useEffect(() => registerSettleWorktreeDialog(), []);
  const settlePrompt = useSyncExternalStore(
    subscribeSettleWorktreeDialog,
    readSettleWorktreeDialog,
    readSettleWorktreeDialog,
  );

  const copy = resolveConfirmDialogCopy(state.status === "idle" ? "" : state.message);
  const confirmVariant = state.status === "idle" ? "default" : state.variant;
  const onCancel = () => respondToConfirmDialog(false);
  const onConfirm = () => respondToConfirmDialog(true);

  return (
    <>
      <AlertDialog
        open={state.status === "confirming"}
        onOpenChange={(open) => {
          if (!open) onCancel();
        }}
        onOpenChangeComplete={(open) => {
          if (!open) completeConfirmDialogClose();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            {copy.description ? (
              <AlertDialogDescription className="whitespace-pre-line">
                {copy.description}
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant={confirmVariant} onClick={onConfirm}>
              Confirm
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={settlePrompt !== null}
        onOpenChange={(open) => {
          if (!open) respondToSettleWorktreeDialog(null);
        }}
      >
        <AlertDialogPopup className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Settle this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This worktree has local changes. You can keep it when settling, or review the changes
              before deleting it. Deleting also removes untracked and ignored files in the worktree.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {settlePrompt && (
            <div className="min-w-0 space-y-2 px-6 text-sm">
              <div className="break-all font-mono text-xs">{settlePrompt.path}</div>
              {settlePrompt.phase === "loading" && (
                <div
                  className="flex items-center gap-2 rounded-md border p-3 text-muted-foreground"
                  role="status"
                >
                  <Spinner size="sm" aria-hidden />
                  Loading changed files and diff summary…
                </div>
              )}
              {settlePrompt.phase === "error" && (
                <div className="space-y-2 rounded-md border p-3" role="alert">
                  <p>Could not load the worktree changes. Try again before deleting it.</p>
                  <Button variant="outline" onClick={retrySettleWorktreeDialog}>
                    Retry
                  </Button>
                </div>
              )}
              {settlePrompt.status && (
                <>
                  <div>
                    {settlePrompt.status.workingTree.files.length} changed{" "}
                    {settlePrompt.status.workingTree.files.length === 1 ? "file" : "files"} · +
                    {settlePrompt.status.workingTree.insertions} −
                    {settlePrompt.status.workingTree.deletions} lines
                  </div>
                  <ul className="max-h-48 space-y-1 overflow-auto rounded-md border p-2 font-mono text-xs">
                    {settlePrompt.status.workingTree.files
                      .slice(0, SETTLE_WORKTREE_VISIBLE_FILES)
                      .map((file) => (
                        <li key={file.path} className="flex justify-between gap-3">
                          <span className="min-w-0 break-all">{file.path}</span>
                          <span className="shrink-0 text-muted-foreground">
                            +{file.insertions} −{file.deletions}
                          </span>
                        </li>
                      ))}
                  </ul>
                  {settlePrompt.status.workingTree.files.length > SETTLE_WORKTREE_VISIBLE_FILES && (
                    <p className="text-muted-foreground">
                      Showing the first {SETTLE_WORKTREE_VISIBLE_FILES} changed files.
                    </p>
                  )}
                </>
              )}
              {!settlePrompt.canDelete && (
                <p className="text-muted-foreground">
                  This worktree is shared or still in use, so it can only be kept.
                </p>
              )}
            </div>
          )}
          <AlertDialogFooter className="flex-col sm:flex-col">
            <Button className="w-full" onClick={() => respondToSettleWorktreeDialog("keep")}>
              Settle and keep worktree
            </Button>
            {settlePrompt?.canDelete && (
              <Button
                className="w-full"
                variant="destructive"
                disabled={settlePrompt.phase !== "ready"}
                onClick={() => respondToSettleWorktreeDialog("delete")}
              >
                Delete worktree and discard local changes
              </Button>
            )}
            <Button
              className="w-full"
              variant="outline"
              onClick={() => respondToSettleWorktreeDialog(null)}
            >
              Cancel
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
