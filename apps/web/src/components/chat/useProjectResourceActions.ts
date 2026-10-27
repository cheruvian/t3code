import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ProjectScript,
} from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  groupedResourceLocks,
  resourceOwnersForAction,
} from "@t3tools/client-runtime/state/resource-lock-grouping";
import { resourceActionKey } from "@t3tools/shared/resourceActions";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadShells } from "../../state/threads";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { readEnvironmentScope } from "../../state/session";
import { readLocalApi } from "../../localApi";
import type { makeThreadErrorSetter } from "../ChatView.logic";

export function useProjectResourceActions(input: {
  readonly activeProject: EnvironmentProject | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly projects: readonly EnvironmentProject[];
  readonly groupingSettings: Parameters<typeof groupedResourceLocks>[0]["settings"];
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly environmentById: ReadonlyMap<EnvironmentId, { readonly label: string }>;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}) {
  const { activeProject, activeThread, environmentById, setThreadError } = input;
  const requestResource = useAtomCommand(projectEnvironment.resource);
  const activeGroupedResourceLocks = activeProject
    ? groupedResourceLocks({
        activeProject,
        projects: input.projects,
        settings: input.groupingSettings,
        primaryEnvironmentId: input.primaryEnvironmentId,
        connectedEnvironmentIds: input.connectedEnvironmentIds,
      })
    : [];
  const resourceOwnerLabels = new Map<string, string>();
  for (const { project, lock } of activeGroupedResourceLocks) {
    const owner = appAtomRegistry.get(
      environmentThreadShells.threadShellAtom({
        environmentId: project.environmentId,
        threadId: lock.threadId,
      }),
    );
    resourceOwnerLabels.set(
      resourceActionKey(lock.script),
      `${owner?.title ?? lock.threadId} on ${environmentById.get(project.environmentId)?.label ?? project.environmentId}`,
    );
  }
  const resourceActionRunning =
    activeThread !== undefined &&
    (activeProject?.resourceLocks?.some(
      (lock) =>
        lock.threadId === activeThread.id &&
        (lock.phase === "checkout" || lock.phase === "release"),
    ) ??
      false);
  const runResourceAction = async (script: ProjectScript) => {
    if (
      !activeProject ||
      !activeThread ||
      !readEnvironmentScope(activeProject.environmentId, AuthTerminalOperateScope)
    )
      return;
    if (script.resource) {
      const owners = resourceOwnersForAction(activeGroupedResourceLocks, script);
      const local = owners.find(
        (entry) =>
          entry.project.environmentId === activeProject.environmentId &&
          entry.project.id === activeProject.id,
      );
      const remote = owners.find((entry) => entry !== local);
      if (owners.length > 1 && local?.lock.threadId !== activeThread.id) {
        setThreadError(
          activeThread.id,
          `Multiple threads hold ${script.name}. Release the conflicting checkouts first.`,
        );
        return;
      }
      const lock = local?.lock ?? remote?.lock;
      const takingOver =
        lock !== undefined &&
        ((remote !== undefined && !local) || lock.threadId !== activeThread.id);
      if (lock && (lock.phase === "checkout" || lock.phase === "release")) {
        setThreadError(activeThread.id, "Resource hooks are still running.");
        return;
      }
      if (takingOver) {
        const ownerProject = local?.project ?? remote?.project;
        const owner = appAtomRegistry.get(
          environmentThreadShells.threadShellAtom({
            environmentId: ownerProject?.environmentId ?? activeProject.environmentId,
            threadId: lock.threadId,
          }),
        );
        const environmentLabel =
          ownerProject && ownerProject.environmentId !== activeProject.environmentId
            ? ` on ${environmentById.get(ownerProject.environmentId)?.label ?? ownerProject.environmentId}`
            : "";
        const confirmed = await readLocalApi()?.dialogs.confirm(
          `Taking over resource from ${owner?.title ?? lock.threadId}${environmentLabel}.`,
          { variant: "destructive" },
        );
        if (!confirmed) return;
      }
      if (remote && !local) {
        const released = await requestResource({
          environmentId: remote.project.environmentId,
          input: {
            projectId: remote.project.id,
            threadId: remote.lock.threadId,
            script: remote.lock.script,
            action: "force-release",
            expectedOperationId: remote.lock.operationId,
          },
        });
        if (released._tag === "Failure") {
          if (!isAtomCommandInterrupted(released)) {
            const error = squashAtomCommandFailure(released);
            setThreadError(
              activeThread.id,
              error instanceof Error ? error.message : "Could not release the other checkout.",
            );
          }
          return;
        }
      }
      const result = await requestResource({
        environmentId: activeProject.environmentId,
        input: {
          projectId: activeProject.id,
          threadId: activeThread.id,
          script,
          action: local ? (takingOver ? "takeover" : "release") : "checkout",
          ...(local ? { expectedOperationId: local.lock.operationId } : {}),
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Resource action failed.",
        );
      }
      return;
    }
  };
  return {
    activeGroupedResourceLocks,
    resourceOwnerLabels,
    resourceActionRunning,
    runResourceAction,
  };
}
