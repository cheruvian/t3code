import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { useConnectedEnvironmentIds } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { requestConfirmDialog } from "~/confirmDialog";
import { Button } from "../ui/button";

export function SidebarDeploymentNotices() {
  const ids = useConnectedEnvironmentIds();
  return ids.map((environmentId) => (
    <DeploymentNotice key={environmentId} environmentId={environmentId} />
  ));
}
function DeploymentNotice({ environmentId }: { environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canAct = useAtomValue(serverEnvironment.deploymentAction.permissionAtom(environmentId));
  return config?.environment.capabilities.managedDeployments && canAct ? (
    <DeploymentNoticeContent environmentId={environmentId} />
  ) : null;
}
function DeploymentNoticeContent({ environmentId }: { environmentId: EnvironmentId }) {
  const result = useAtomValue(serverEnvironment.deploymentState({ environmentId, input: {} }));
  const canAct = useAtomValue(serverEnvironment.deploymentAction.permissionAtom(environmentId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const act = useAtomCommand(serverEnvironment.deploymentAction);
  const [pending, setPending] = useState(false);
  const state = AsyncResult.isSuccess(result) ? result.value : null;
  if (!state) return null;
  const apply = async (action: "force" | "cancel") => {
    if (
      action === "force" &&
      !(await requestConfirmDialog(
        "Update this environment now? Running threads will be interrupted while it restarts.",
      ))
    )
      return;
    setPending(true);
    try {
      await act({ environmentId, input: { id: state.id, action } });
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="rounded-md bg-sidebar-control-surface p-2 text-xs text-sidebar-foreground">
      <p role="status">
        {state.status === "installing"
          ? "Installing update"
          : state.status === "failed"
            ? "Update failed"
            : "Update queued"}{" "}
        · {state.revision.slice(0, 7)}
      </p>
      <p className="mt-1 text-muted-foreground">
        {config?.environment.label ?? "This environment"}
        {state.status === "queued"
          ? ` · waiting for ${state.busyThreads} ${state.busyThreads === 1 ? "thread" : "threads"}${state.pendingEffects > 0 ? " and pending work" : ""}`
          : state.status === "failed"
            ? " · check deployment logs"
            : " · reconnecting shortly"}
      </p>
      {state.status !== "installing" ? (
        <div className="mt-2 flex gap-2">
          {state.status === "queued" ? (
            <Button
              size="xs"
              variant="secondary"
              disabled={!canAct || pending}
              onClick={() => void apply("force")}
            >
              Update now
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            disabled={!canAct || pending}
            onClick={() => void apply("cancel")}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}
