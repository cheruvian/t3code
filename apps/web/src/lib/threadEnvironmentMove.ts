import {
  threadMoveDestinations,
  threadMoveUndoParticipants,
} from "@t3tools/client-runtime/operations";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, readThreadShell, waitForThreadShell } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { toastManager } from "../components/ui/toast";

export function readThreadMoveDestinations(ref: ScopedThreadRef) {
  const thread = readThreadShell(ref);
  return thread
    ? threadMoveDestinations({
        thread,
        projects: readProjects(),
        configs: appAtomRegistry.get(environmentServerConfigsAtom),
      })
    : [];
}

export async function moveThreadToEnvironment(
  ref: ScopedThreadRef,
  destinationEnvironmentId: EnvironmentId,
) {
  const destination = readThreadMoveDestinations(ref).find(
    (candidate) => candidate.environmentId === destinationEnvironmentId,
  );
  const thread = readThreadShell(ref);
  if (!destination || !thread) return false;
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.move,
    {
      environmentId: ref.environmentId,
      input: {
        threadId: ref.threadId,
        destinationEnvironmentId,
        projectId: destination.projectId,
        instanceId: destination.instanceId,
        ...(thread.environmentMove?.moveId ? { moveId: thread.environmentMove.moveId } : {}),
      },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Thread move needs attention",
      description: `${error instanceof Error ? error.message : String(error)} Open the move action again to retry or reconcile it.`,
    });
    return false;
  }
  const destinationReady = await waitForThreadShell({
    environmentId: destinationEnvironmentId,
    threadId: ref.threadId,
  });
  if (!destinationReady) {
    toastManager.add({
      type: "warning",
      title: "Thread moved; refresh needed",
      description:
        "The move completed, but the destination thread has not appeared yet. Refresh before opening it.",
    });
    return false;
  }
  toastManager.add({ type: "success", title: `Thread moved to ${destination.label}` });
  return true;
}

export async function undoThreadEnvironmentMove(
  ref: ScopedThreadRef,
  snapshot?: import("@t3tools/client-runtime/state/models").EnvironmentThreadShell,
) {
  const thread = snapshot ?? readThreadShell(ref);
  const input = thread ? threadMoveUndoParticipants(thread) : null;
  if (!input) return false;
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.undoMove,
    { environmentId: ref.environmentId, input },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not undo move",
      description: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  const sourceReady = await waitForThreadShell({
    environmentId: input.sourceEnvironmentId,
    threadId: ref.threadId,
  });
  if (!sourceReady) {
    toastManager.add({
      type: "warning",
      title: "Thread restored; refresh needed",
      description:
        "The undo completed, but the source thread has not appeared yet. Refresh before opening it.",
    });
    return false;
  }
  toastManager.add({ type: "success", title: "Thread restored to its source environment" });
  return true;
}
