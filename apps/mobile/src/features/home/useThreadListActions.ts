import {
  beginThreadMoveProgress,
  threadMoveDestinations,
  threadMoveUnavailableLabel,
  threadMoveUndoParticipants,
} from "@t3tools/client-runtime/operations";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type VcsStatusLocalResult,
  AuthOrchestrationOperateScope,
} from "@t3tools/contracts";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { allowUnpinnedReorderAtom } from "../../state/preferences";
import {
  type ThreadMoveDestination,
  createPendingThreadOrder,
  createThreadMovePlanner,
  threadDropLifecycle,
} from "../threads/threadOrder";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { showThreadUndoNotice } from "./thread-undo-notice";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";

import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useRef } from "react";

import { withThreadDismissal } from "./thread-dismissal";
import * as Dialog from "../../components/ui/Dialog";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { refreshArchivedThreadsForEnvironment } from "../archive/useArchivedThreadSnapshots";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import { terminalEnvironment } from "../../state/terminal";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  beginPendingThreadOrder,
  getPendingThreadOrder,
  threadDropBusyAtom,
} from "../../state/thread-order";

import { getThreadListV2OrderedSection } from "../threads/threadListV2";
import { threadCanArchive } from "./threadArchive";
import { threadShellIsIdleForWorktreeCleanup } from "@t3tools/client-runtime/state/models";
import { getWorktreeCleanupOwners } from "@t3tools/shared/worktreeOwnership";
import { resolveThreadTitleRename } from "../threads/thread-title-rename";

export function readMobileThreadMoveAvailability(thread: EnvironmentThreadShell) {
  const input = {
    thread,
    projects: appAtomRegistry.get(environmentProjects.projectsAtom),
    configs: appAtomRegistry.get(environmentServerConfigsAtom),
  };
  const moveEnvironmentDestinations = threadMoveDestinations(input);
  return {
    moveEnvironmentDestinations,
    moveEnvironmentUnavailableLabel: threadMoveUnavailableLabel(input, moveEnvironmentDestinations),
  };
}

export async function moveMobileThreadToEnvironment(
  thread: EnvironmentThreadShell,
  environmentId: EnvironmentId,
) {
  const destination = readMobileThreadMoveAvailability(thread).moveEnvironmentDestinations.find(
    (candidate) => candidate.environmentId === environmentId,
  );
  if (!destination) return;
  const progress = beginThreadMoveProgress(
    { environmentId: thread.environmentId, threadId: thread.id },
    destination.label,
  );
  if (!progress) return;
  try {
    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.move,
      {
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          destinationEnvironmentId: environmentId,
          projectId: destination.projectId,
          instanceId: destination.instanceId,
          onProgress: progress.update,
          ...(thread.environmentMove?.moveId ? { moveId: thread.environmentMove.moveId } : {}),
        },
      },
      { reportFailure: false },
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Thread move needs attention",
        `${error instanceof Error ? error.message : String(error)} Open the move action again to retry or reconcile it.`,
      );
    } else Dialog.alert("Thread moved", `Continue this thread on ${destination.label}.`);
  } finally {
    progress.finish();
  }
}

export async function undoMobileThreadMove(thread: EnvironmentThreadShell) {
  const input = threadMoveUndoParticipants(thread);
  if (!input) return false;
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.undoMove,
    { environmentId: thread.environmentId, input },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    Dialog.alert("Could not undo move", error instanceof Error ? error.message : String(error));
    return false;
  }
  refreshArchivedThreadsForEnvironment(thread.environmentId);
  Dialog.alert("Move undone", "Continue this thread in its source environment.");
  return true;
}

/** Older servers default the settlement capability to false; never send them settle/unsettle. */
function environmentSupportsSettlement(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSettlement === true
  );
}

function environmentSupportsSnooze(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSnooze === true
  );
}

function environmentSupportsPinning(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinning === true
  );
}

function environmentSupportsPinReorder(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinReorder === true
  );
}

function environmentSupportsAutoSettleOptOut(
  environmentId: EnvironmentThreadShell["environmentId"],
) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadAutoSettleOptOut === true
  );
}

function environmentSupportsTitleRegeneration(
  environmentId: EnvironmentThreadShell["environmentId"],
) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadTitleRegeneration === true
  );
}

type ThreadListAction = "archive" | "unarchive" | "delete" | "settle" | "unsettle";

const ACTION_VERBS: Record<ThreadListAction, string> = {
  archive: "archived",
  unarchive: "unarchived",
  delete: "deleted",
  settle: "settled",
  unsettle: "un-settled",
};

function actionFailureMessage(action: ThreadListAction, cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return `The thread could not be ${ACTION_VERBS[action]}.`;
}

function selectionHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

function actionFailureTitle(action: ThreadListAction): string {
  if (action === "archive") return "Could not archive thread";
  if (action === "unarchive") return "Could not unarchive thread";
  if (action === "settle") return "Could not settle thread";
  if (action === "unsettle") return "Could not un-settle thread";
  return "Could not delete thread";
}

function checkThreadOperationPermission(thread: EnvironmentThreadShell, title: string): boolean {
  if (readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) return true;
  Dialog.alert(title, "This connection cannot change threads.");
  return false;
}

function confirmSettlement(
  hasWorktree: boolean,
  status: VcsStatusLocalResult | null,
  canDelete: boolean,
  resourceNames: readonly string[],
) {
  return new Promise<{
    deleteWorktree: boolean;
    stopRunningProcesses: boolean;
    removeAutomations: boolean;
    releaseResources: boolean;
  } | null>((resolve) => {
    const changes = !hasWorktree
      ? "The conversation is kept and can be reopened."
      : status
        ? `${status.workingTree.files.length} changed files · +${status.workingTree.insertions} −${status.workingTree.deletions} lines.\n${status.workingTree.files
            .slice(0, 5)
            .map((file) => file.path)
            .join("\n")}`
        : "Could not load the worktree changes. You can settle and keep the worktree.";
    const worktreeWarning = hasWorktree
      ? `\n\nDeleting removes the entire worktree, including untracked and ignored files such as .env. The conversation and Git branch are kept.${canDelete ? "" : "\nThis worktree is shared or still in use, so it can only be kept."}`
      : "";
    Dialog.confirm({
      title: "Settle this conversation?",
      message: `${changes}${worktreeWarning}${resourceNames.length > 0 ? "\n\nResource release hooks must finish before settling. Reopening does not check them out again." : ""}\n\nStopping processes ends background commands and dev servers started by the agent. Reopening does not restart them. Deleting the worktree always stops them.\n\nRemoved automations stop running and are not restored when reopened. Turn this off to keep them active. Automations that create new conversations are kept.`,
      confirmText: "Settle",
      options: [
        ...(resourceNames.length > 0
          ? [
              {
                id: "releaseResources",
                label: `Release resource locks (${resourceNames.join(", ")})`,
                defaultChecked: false,
              },
            ]
          : []),
        { id: "stopRunningProcesses", label: "Stop running processes", defaultChecked: true },
        { id: "removeAutomations", label: "Remove bound automations", defaultChecked: true },
        ...(canDelete && status
          ? [{ id: "deleteWorktree", label: "Delete worktree", defaultChecked: false }]
          : []),
      ],
      onConfirm: (options) =>
        resolve({
          stopRunningProcesses:
            options.deleteWorktree === true || options.stopRunningProcesses !== false,
          releaseResources: options.releaseResources === true,
          removeAutomations: options.removeAutomations !== false,
          deleteWorktree: options.deleteWorktree === true,
        }),
      onCancel: () => resolve(null),
    });
  });
}

/** Resolves to true iff the action was dispatched and succeeded. */
function useThreadActionExecutor(
  onCompleted?: (action: ThreadListAction, thread: EnvironmentThreadShell) => void,
) {
  const archiveMutation = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveMutation = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const deleteMutation = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const releaseThreadResources = useAtomCommand(projectEnvironment.releaseThreadResources, {
    reportFailure: false,
  });
  const settleMutation = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettleMutation = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const readWorktreeStatus = useAtomCommand(vcsEnvironment.localStatus, { reportFailure: false });
  const stopSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const removeConfirmedWorktree = useAtomCommand(vcsEnvironment.removeConfirmedWorktree, {
    reportFailure: false,
  });
  const inFlightThreadKeys = useRef(new Set<string>());

  const executeAction = async (
    action: ThreadListAction,
    thread: EnvironmentThreadShell,
    onStarted?: () => void,
  ) => {
    if (!checkThreadOperationPermission(thread, actionFailureTitle(action))) return false;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (inFlightThreadKeys.current.has(key)) {
      return false;
    }

    inFlightThreadKeys.current.add(key);
    selectionHaptic();
    try {
      if (action === "unarchive" && threadMoveUndoParticipants(thread))
        return await undoMobileThreadMove(thread);
      if (
        (action === "settle" || action === "unsettle") &&
        !environmentSupportsSettlement(thread.environmentId)
      ) {
        Dialog.alert(
          actionFailureTitle(action),
          "This environment's server does not support settling yet. Update the server to use Settle.",
        );
        return false;
      }
      // Archive keeps its original, narrower guard: never interrupt a
      // thread mid-turn.
      if (action === "archive" && !threadCanArchive(thread.runtime)) {
        Dialog.alert(
          actionFailureTitle(action),
          "This thread is working. Interrupt it first, then try again.",
        );
        return false;
      }
      let deleteWorktreePreview: VcsStatusLocalResult | null = null;
      let stopRunningProcesses = true;
      let removeAutomations = true;
      let releaseResources = false;
      const resourceLocks = (
        appAtomRegistry.get(
          environmentProjects.projectAtom({
            environmentId: thread.environmentId,
            projectId: thread.projectId,
          }),
        )?.resourceLocks ?? []
      ).filter((lock) => lock.threadId === thread.id);
      const resourceNames = resourceLocks.map((lock) => lock.script.name);
      if (action === "settle" && thread.worktreePath) {
        const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
        const owners = getWorktreeCleanupOwners(
          shells.filter(
            (entry) =>
              entry.environmentId === thread.environmentId &&
              entry.worktreePath === thread.worktreePath,
          ),
          thread.id,
          threadShellIsIdleForWorktreeCleanup,
        );
        const canDelete = owners.length === 1 && threadCanArchive(thread.runtime);
        const status = await readWorktreeStatus({
          environmentId: thread.environmentId,
          input: { cwd: thread.worktreePath, includeBranchChanges: false },
        });
        const preview = status._tag === "Success" ? status.value : null;
        const decision = await confirmSettlement(true, preview, canDelete, resourceNames);
        if (decision === null) return false;
        stopRunningProcesses = decision.stopRunningProcesses;
        removeAutomations = decision.removeAutomations;
        releaseResources = decision.releaseResources;
        if (decision.deleteWorktree) deleteWorktreePreview = preview;
      } else if (action === "settle") {
        const decision = await confirmSettlement(false, null, false, resourceNames);
        if (decision === null) return false;
        stopRunningProcesses = decision.stopRunningProcesses;
        removeAutomations = decision.removeAutomations;
        releaseResources = decision.releaseResources;
      }
      if (releaseResources) {
        const released = await releaseThreadResources({
          environmentId: thread.environmentId,
          input: { projectId: thread.projectId, threadId: thread.id, locks: resourceLocks },
        });
        if (released._tag === "Failure") {
          Dialog.alert(
            "Could not release resources",
            actionFailureMessage("settle", released.cause),
          );
          return false;
        }
      }
      if (action === "unsettle") ThreadUndo.invalidate("settle", key);
      if (action === "archive" || action === "delete") {
        for (const kind of ["settle", "snooze", "pin"]) ThreadUndo.invalidate(kind, key);
      }
      onStarted?.();
      const result = await withThreadDismissal(
        key,
        async () =>
          action === "unsettle"
            ? // reason "user" pins the thread active: auto-settle stays
              // suppressed until real activity clears the pin server-side.
              await unsettleMutation({
                environmentId: thread.environmentId,
                input: { threadId: thread.id, reason: "user" },
              })
            : action === "settle"
              ? await settleMutation({
                  environmentId: thread.environmentId,
                  input: { threadId: thread.id, removeAutomations, stopRunningProcesses },
                })
              : await (
                  action === "archive"
                    ? archiveMutation
                    : action === "unarchive"
                      ? unarchiveMutation
                      : deleteMutation
                )({
                  environmentId: thread.environmentId,
                  input: { threadId: thread.id },
                }),
        (result) => result._tag === "Success",
      );
      if (result._tag === "Failure") {
        Dialog.alert(actionFailureTitle(action), actionFailureMessage(action, result.cause));
        return false;
      }
      if (deleteWorktreePreview) {
        const target = { environmentId: thread.environmentId, input: { threadId: thread.id } };
        const stopped = thread.runtime ? await stopSession(target) : null;
        const closed =
          stopped === null || stopped._tag === "Success"
            ? await closeTerminal({
                ...target,
                input: { threadId: thread.id, deleteHistory: false },
              })
            : stopped;
        const removal =
          closed._tag === "Success"
            ? await removeConfirmedWorktree({
                environmentId: thread.environmentId,
                input: {
                  threadId: thread.id,
                  expectedRefName: deleteWorktreePreview.refName,
                  expectedFiles: deleteWorktreePreview.workingTree.files,
                },
              })
            : null;
        if (
          closed._tag === "Failure" ||
          removal?._tag === "Failure" ||
          (removal?._tag === "Success" && !removal.value.removed)
        ) {
          Dialog.alert(
            "Conversation settled, but worktree was kept",
            "The worktree changed or is still in use. Review it before deleting.",
          );
        }
      }
      // Settled threads stay in the live shell stream; only the archive
      // lifecycle still feeds the archived-snapshot surface.
      if (action === "archive" || action === "unarchive" || action === "delete") {
        refreshArchivedThreadsForEnvironment(thread.environmentId);
      }
      onCompleted?.(action, thread);
      return true;
    } finally {
      inFlightThreadKeys.current.delete(key);
    }
  };

  return executeAction;
}

// Hookless use* functions skip compilation, leaving their returned handlers unstable.
function confirmThreadDeletion(
  executeAction: (action: ThreadListAction, thread: EnvironmentThreadShell) => Promise<boolean>,
  thread: EnvironmentThreadShell,
) {
  if (!checkThreadOperationPermission(thread, actionFailureTitle("delete"))) return;
  const title = "Delete thread?";
  const message = `“${thread.title}” will be permanently deleted, including its terminal history.`;
  Dialog.confirm({
    title,
    message,
    confirmText: "Delete",
    destructive: true,
    onConfirm: () => {
      void executeAction("delete", thread);
    },
  });
}

export function useThreadListActions(): {
  readonly archiveThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly settleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly snoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => Promise<boolean>;
  readonly unsnoozeThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unsettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly pinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unpinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  /** Sets per-thread automatic settlement on or off. */
  readonly setThreadAutoSettle: (
    thread: EnvironmentThreadShell,
    enabled: boolean,
  ) => Promise<boolean>;
  readonly moveThread: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => Promise<boolean>;
  readonly renameThread: (thread: EnvironmentThreadShell) => void;
  readonly regenerateThreadTitle: (thread: EnvironmentThreadShell) => Promise<boolean>;
} {
  const executeAction = useThreadActionExecutor();
  const snoozeMutation = useAtomCommand(threadEnvironment.snooze, { reportFailure: false });
  const unsnoozeMutation = useAtomCommand(threadEnvironment.unsnooze, { reportFailure: false });
  const pinMutation = useAtomCommand(threadEnvironment.pin, { reportFailure: false });
  const unpinMutation = useAtomCommand(threadEnvironment.unpin, { reportFailure: false });
  const setAutoSettleMutation = useAtomCommand(threadEnvironment.setAutoSettle, {
    reportFailure: false,
  });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const snoozeInFlightThreadKeys = useRef(new Set<string>());
  const titleRegenerationInFlightThreadKeys = useRef(new Set<string>());

  const archiveThread = (thread: EnvironmentThreadShell) => executeAction("archive", thread);
  const offerUndo = (
    thread: EnvironmentThreadShell,
    action: "Settled" | "Snoozed" | "Unpinned",
    claim: ReturnType<typeof ThreadUndo.begin>,
    plan: ThreadUndo.ThreadUndoPlan,
  ) =>
    showThreadUndoNotice({
      action,
      claim,
      undo: async () => {
        try {
          await ThreadUndo.executeThreadUndo(
            plan,
            async (step) => {
              switch (step.action) {
                case "unsettle":
                  return unsettleThread(thread);
                case "unsnooze":
                  return unsnoozeThread(thread);
                case "pin":
                  return pinThread(thread, step.orderKey);
                case "snooze": {
                  const failureTitle =
                    action === "Unpinned" ? "Could not undo unpin" : "Could not undo settle";
                  if (!checkThreadOperationPermission(thread, failureTitle)) return false;
                  const result = await snoozeMutation({
                    environmentId: thread.environmentId,
                    input: { threadId: thread.id, snoozedUntil: step.snoozedUntil },
                  });
                  if (result._tag === "Failure") {
                    const error = Cause.squash(result.cause);
                    Dialog.alert(
                      "Could not restore snooze",
                      error instanceof Error ? error.message : "The thread could not be snoozed.",
                    );
                    return false;
                  }
                  return true;
                }
              }
            },
            (result) => result,
          );
        } catch (error) {
          Dialog.alert(
            "Could not undo thread action",
            error instanceof Error ? error.message : "Try again.",
          );
        }
      },
    });
  const settleThread = async (thread: EnvironmentThreadShell) => {
    const key = scopedThreadKey(thread.environmentId, thread.id);
    const plan = ThreadUndo.planThreadUndo("settle", thread);
    let claim: ReturnType<typeof ThreadUndo.begin> | undefined;
    const succeeded = await executeAction("settle", thread, () => {
      ThreadUndo.invalidate("pin", key);
      ThreadUndo.invalidate("snooze", key);
      claim = ThreadUndo.begin("settle", key);
    });
    if (claim) {
      if (succeeded) offerUndo(thread, "Settled", claim, plan);
      else claim.finish();
    }
    return succeeded;
  };
  const snoozeThread = async (thread: EnvironmentThreadShell, snoozedUntil: string) => {
    if (!checkThreadOperationPermission(thread, "Could not snooze thread")) return false;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (snoozeInFlightThreadKeys.current.has(key)) {
      return false;
    }
    snoozeInFlightThreadKeys.current.add(key);
    const succeeded = await (async () => {
      if (!environmentSupportsSnooze(thread.environmentId)) {
        Dialog.alert(
          "Could not snooze thread",
          "This environment's server does not support snoozing yet. Update the server to use Snooze.",
        );
        return false;
      }
      if (!canSnooze(thread, { now: new Date().toISOString() })) {
        Dialog.alert(
          "Could not snooze thread",
          thread.hasPendingApprovals ||
            thread.hasPendingUserInput ||
            thread.pendingSubagentRequest != null
            ? "This thread is waiting on you. Respond to the pending request before snoozing it."
            : "This thread is still starting a turn. Try again once it's running.",
        );
        return false;
      }

      selectionHaptic();
      const claim = ThreadUndo.begin("snooze", key);
      const result = await withThreadDismissal(
        key,
        () =>
          snoozeMutation({
            environmentId: thread.environmentId,
            input: {
              threadId: thread.id,
              snoozedUntil,
            },
          }),
        (result) => result._tag === "Success",
      );
      if (result._tag === "Failure") {
        claim.finish();
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Could not snooze thread",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread could not be snoozed.",
        );
        return false;
      }
      offerUndo(thread, "Snoozed", claim, ThreadUndo.planThreadUndo("snooze"));
      return true;
    })();
    snoozeInFlightThreadKeys.current.delete(key);
    return succeeded;
  };
  const unsnoozeThread = async (thread: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, "Could not wake thread")) return false;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (snoozeInFlightThreadKeys.current.has(key)) {
      return false;
    }
    snoozeInFlightThreadKeys.current.add(key);
    const succeeded = await (async () => {
      if (!environmentSupportsSnooze(thread.environmentId)) {
        Dialog.alert(
          "Could not wake thread",
          "This environment's server does not support snoozing yet. Update the server to wake this thread.",
        );
        return false;
      }

      selectionHaptic();
      ThreadUndo.invalidate("snooze", key);
      const result = await withThreadDismissal(
        key,
        () =>
          unsnoozeMutation({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, reason: "user" },
          }),
        (result) => result._tag === "Success",
      );
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Could not wake thread",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread could not be woken.",
        );
        return false;
      }
      return true;
    })();
    snoozeInFlightThreadKeys.current.delete(key);
    return succeeded;
  };
  const unsettleThread = async (thread: EnvironmentThreadShell) =>
    (await executeAction("unsettle", thread)) === true;
  const pinThread = async (thread: EnvironmentThreadShell, restoreOrderKey?: string) => {
    if (!checkThreadOperationPermission(thread, "Could not pin thread")) return false;
    if (!environmentSupportsPinning(thread.environmentId)) {
      Dialog.alert(
        "Could not pin thread",
        "This environment's server does not support pinning yet. Update the server to use Pin.",
      );
      return false;
    }
    selectionHaptic();
    let orderKey: string | undefined;
    if (environmentSupportsPinReorder(thread.environmentId)) {
      const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
      let firstKey: string | null = null;
      for (const shell of shells) {
        if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
        if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
      }
      orderKey = pinOrderKeyBetween(null, firstKey) ?? undefined;
    }
    orderKey = environmentSupportsPinReorder(thread.environmentId)
      ? (restoreOrderKey ?? orderKey)
      : undefined;
    ThreadUndo.invalidate("pin", scopedThreadKey(thread.environmentId, thread.id));
    // Pinning clears snooze, so older Settled or Snoozed undos would fight this pin.
    ThreadUndo.invalidate("settle", scopedThreadKey(thread.environmentId, thread.id));
    ThreadUndo.invalidate("snooze", scopedThreadKey(thread.environmentId, thread.id));
    const result = await withThreadDismissal(
      scopedThreadKey(thread.environmentId, thread.id),
      () =>
        pinMutation({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, ...(orderKey !== undefined ? { orderKey } : {}) },
        }),
      (result) => result._tag === "Success",
    );
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Could not pin thread",
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The thread could not be pinned.",
      );
      return false;
    }
    return true;
  };
  const unpinThread = async (thread: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, "Could not unpin thread")) return false;
    if (!environmentSupportsPinning(thread.environmentId)) {
      Dialog.alert(
        "Could not unpin thread",
        "This environment's server does not support pinning yet. Update the server to use Pin.",
      );
      return false;
    }
    selectionHaptic();
    const plan = ThreadUndo.planThreadUndo("unpin", thread);
    const claim = ThreadUndo.begin("pin", scopedThreadKey(thread.environmentId, thread.id));
    const result = await withThreadDismissal(
      scopedThreadKey(thread.environmentId, thread.id),
      () =>
        unpinMutation({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        }),
      (result) => result._tag === "Success",
    );
    if (result._tag === "Failure") {
      claim.finish();
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Could not unpin thread",
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The thread could not be unpinned.",
      );
      return false;
    }
    offerUndo(thread, "Unpinned", claim, plan);
    return true;
  };
  const setThreadAutoSettle = async (thread: EnvironmentThreadShell, enabled: boolean) => {
    if (!environmentSupportsAutoSettleOptOut(thread.environmentId)) {
      Dialog.alert(
        "Could not update auto-settle",
        "This environment's server does not support turning auto-settle off per thread yet. Update the server to use it.",
      );
      return false;
    }
    selectionHaptic();
    const result = await setAutoSettleMutation({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, enabled },
    });
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Could not update auto-settle",
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The auto-settle setting could not be changed.",
      );
      return false;
    }
    return true;
  };
  const regenerateThreadTitle = async (thread: EnvironmentThreadShell) => {
    if (!checkThreadOperationPermission(thread, "Could not regenerate title")) return false;
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (thread.titleRegeneration != null || titleRegenerationInFlightThreadKeys.current.has(key)) {
      return false;
    }
    if (!environmentSupportsTitleRegeneration(thread.environmentId)) {
      Dialog.alert(
        "Could not regenerate title",
        "This environment's server does not support title regeneration yet. Update the server to regenerate thread titles.",
      );
      return false;
    }

    titleRegenerationInFlightThreadKeys.current.add(key);
    selectionHaptic();
    const succeeded = await (async () => {
      const result = await updateThreadMetadata({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, regenerateTitle: true },
      });
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Could not regenerate title",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread title could not be regenerated.",
        );
        return false;
      }
      return true;
    })();
    titleRegenerationInFlightThreadKeys.current.delete(key);
    return succeeded;
  };
  const renameThread = (thread: EnvironmentThreadShell) => {
    const commit = (title: string) => {
      const resolution = resolveThreadTitleRename({ title, originalTitle: thread.title });
      if (resolution.action === "reject-empty") {
        Dialog.alert("Could not rename thread", "Thread title cannot be empty.");
        return;
      }
      if (resolution.action === "noop") return;
      selectionHaptic();
      void updateThreadMetadata({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, title: resolution.title },
      }).then((result) => {
        if (result._tag === "Success") return;
        const error = Cause.squash(result.cause);
        Dialog.alert(
          "Could not rename thread",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread could not be renamed.",
        );
      });
    };

    Dialog.prompt({
      title: "Rename thread",
      initialValue: thread.title,
      confirmText: "Rename",
      onConfirm: commit,
    });
  };

  // Plan against the complete section so filtering does not change a move.
  const reorderPinnedMutation = useAtomCommand(threadEnvironment.reorderPin, {
    reportFailure: false,
  });
  const reorderActiveMutation = useAtomCommand(threadEnvironment.reorderActive, {
    reportFailure: false,
  });
  const moveThread = async (thread: EnvironmentThreadShell, direction: ThreadMoveDestination) => {
    if (!checkThreadOperationPermission(thread, "Could not move thread")) return false;
    if (getPendingThreadOrder() !== null || appAtomRegistry.get(threadDropBusyAtom)) return false;
    const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
    const current = shells.find(
      (row) => row.id === thread.id && row.environmentId === thread.environmentId,
    );
    if (!current || current.archivedAt !== null) return false;
    thread = current;
    const section =
      typeof direction === "object" && direction.section !== undefined
        ? direction.section
        : thread.pinnedAt != null
          ? "pinned"
          : "active";
    const allowUnpinnedReorder = appAtomRegistry.get(allowUnpinnedReorderAtom);
    if (section === "active" && !allowUnpinnedReorder) return false;
    if (section === "settled") {
      if (!environmentSupportsSettlement(thread.environmentId)) return false;
      appAtomRegistry.set(threadDropBusyAtom, true);
      const settled = await settleThread(thread);
      appAtomRegistry.set(threadDropBusyAtom, false);
      return settled;
    }
    const configs = appAtomRegistry.get(environmentServerConfigsAtom);
    const supportsReorder = (environmentId: EnvironmentThreadShell["environmentId"]) => {
      const capabilities = configs.get(environmentId)?.environment.capabilities;
      return section === "pinned"
        ? capabilities?.threadPinReorder === true
        : capabilities?.threadActiveReorder === true;
    };
    if (!supportsReorder(thread.environmentId)) {
      Dialog.alert(
        "Could not move thread",
        "This environment's server does not support reordering these threads. Update the server to arrange them.",
      );
      return false;
    }
    const ordered = getThreadListV2OrderedSection({
      allowUnpinnedReorder,
      threads: shells,
      section,
      now: new Date().toISOString(),
      queuedThreadKeys: appAtomRegistry.get(queuedThreadKeysAtom),
      settlementEnvironmentIds: new Set(
        [...configs].flatMap(([id, config]) =>
          config.environment.capabilities.threadSettlement === true ? [id] : [],
        ),
      ),
      snoozeEnvironmentIds: new Set(
        [...configs].flatMap(([id, config]) =>
          config.environment.capabilities.threadSnooze === true ? [id] : [],
        ),
      ),
    });
    const assignments = createThreadMovePlanner({
      allThreads: shells,
      ordered,
      section,
      reorderableEnvironmentIds: new Set([...configs.keys()].filter(supportsReorder)),
    })(scopedThreadKey(thread.environmentId, thread.id), direction);
    if (assignments === null) return false;
    const lifecycle = threadDropLifecycle(thread, section, new Date().toISOString());
    const crossSection = !ordered.some(
      (row) => row.id === thread.id && row.environmentId === thread.environmentId,
    );
    if (
      crossSection &&
      (((section === "pinned" || thread.pinnedAt != null) &&
        !environmentSupportsPinning(thread.environmentId)) ||
        (thread.settledOverride === "settled" &&
          !environmentSupportsSettlement(thread.environmentId)) ||
        (effectiveSnoozed(thread, { now: new Date().toISOString() }) &&
          !environmentSupportsSnooze(thread.environmentId)))
    )
      return false;
    const shellByKey = new Map(
      shells.map((shell) => [scopedThreadKey(shell.environmentId, shell.id), shell]),
    );
    for (const assignment of assignments) {
      const target = shellByKey.get(assignment.id);
      if (target && !checkThreadOperationPermission(target, "Could not move thread")) return false;
    }
    selectionHaptic();
    appAtomRegistry.set(threadDropBusyAtom, true);
    const pending = crossSection
      ? null
      : beginPendingThreadOrder(
          createPendingThreadOrder({
            section,
            ordered,
            movedId: scopedThreadKey(thread.environmentId, thread.id),
            direction,
            assignments,
          }),
        );
    const reorder = section === "pinned" ? reorderPinnedMutation : reorderActiveMutation;
    const moved = await (async () => {
      if (crossSection) {
        if (section === "pinned") {
          const orderKey = assignments.find(
            ({ id }) => id === scopedThreadKey(thread.environmentId, thread.id),
          )?.orderKey;
          // Same as pinThread: older Unpinned, Settled, or Snoozed undos would fight this pin.
          ThreadUndo.invalidate("pin", scopedThreadKey(thread.environmentId, thread.id));
          ThreadUndo.invalidate("settle", scopedThreadKey(thread.environmentId, thread.id));
          ThreadUndo.invalidate("snooze", scopedThreadKey(thread.environmentId, thread.id));
          const result = await pinMutation({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, ...(orderKey === undefined ? {} : { orderKey }) },
          });
          if (result._tag === "Failure") {
            Dialog.alert("Could not pin thread", String(Cause.squash(result.cause)));
            return false;
          }
        } else {
          if (lifecycle.unpin && !(await unpinThread(thread))) return false;
          if (lifecycle.unsettle && !(await unsettleThread(thread))) return false;
          if (lifecycle.unsnooze && !(await unsnoozeThread(thread))) return false;
        }
      }
      for (const assignment of assignments) {
        if (
          crossSection &&
          section === "pinned" &&
          thread.pinnedAt == null &&
          assignment.id === scopedThreadKey(thread.environmentId, thread.id)
        )
          continue;
        if (pending !== null && !pending.isPending()) return false;
        const target = shellByKey.get(assignment.id);
        if (target === undefined) continue;
        if (!checkThreadOperationPermission(target, "Could not move thread")) return false;
        ThreadUndo.invalidate("pin", scopedThreadKey(target.environmentId, target.id));
        const result = await reorder({
          environmentId: target.environmentId,
          input: { threadId: target.id, orderKey: assignment.orderKey },
        });
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          Dialog.alert(
            "Could not move thread",
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "The thread could not be moved.",
          );
          // Keep confirmed keys when a later environment rejects its write.
          return false;
        }
      }
      pending?.complete();
      return true;
    })();
    if (!moved) pending?.cancel();
    appAtomRegistry.set(threadDropBusyAtom, false);
    return moved;
  };

  const confirmDeleteThread = (thread: EnvironmentThreadShell) =>
    confirmThreadDeletion(executeAction, thread);

  return {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    moveThread,
    renameThread,
    regenerateThreadTitle,
  };
}

export function useArchivedThreadListActions(
  onCompleted: (thread: EnvironmentThreadShell) => void,
): {
  readonly unarchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
} {
  const handleCompleted = (_action: ThreadListAction, thread: EnvironmentThreadShell) => {
    onCompleted(thread);
  };
  const executeAction = useThreadActionExecutor(handleCompleted);
  const unarchiveThread = (thread: EnvironmentThreadShell) => {
    void executeAction("unarchive", thread);
  };
  const confirmDeleteThread = (thread: EnvironmentThreadShell) =>
    confirmThreadDeletion(executeAction, thread);

  return { unarchiveThread, confirmDeleteThread };
}
