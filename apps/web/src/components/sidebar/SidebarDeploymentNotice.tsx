import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";
import { useConnectedEnvironmentIds } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { requestConfirmDialog } from "~/confirmDialog";
import { Button } from "../ui/button";

const COLLAPSED_THREAD_LIMIT = 4;

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
  const [expandedDeploymentId, setExpandedDeploymentId] = useState<string | null>(null);
  const threadListId = useId();
  const state = AsyncResult.isSuccess(result) ? result.value : null;
  if (!state) return null;
  const blockingThreads = state.blockingThreads ?? [];
  const expanded = expandedDeploymentId === state.id;
  const visibleThreads = expanded
    ? blockingThreads
    : blockingThreads.slice(0, COLLAPSED_THREAD_LIMIT);
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
    <div className="min-w-0 rounded-lg border border-sidebar-border bg-sidebar-control-surface/50 p-2.5 text-xs text-sidebar-foreground">
      <p className="font-medium" role="status">
        {state.status === "installing"
          ? "Installing update"
          : state.status === "failed"
            ? "Update failed"
            : "Update queued"}{" "}
        <span className="font-normal text-muted-foreground">· {state.revision.slice(0, 7)}</span>
      </p>
      <p className="mt-1 wrap-anywhere text-muted-foreground">
        {config?.environment.label ?? "This environment"}
        {state.status === "queued"
          ? ` · waiting for ${state.busyThreads} ${state.busyThreads === 1 ? "thread" : "threads"}${state.pendingEffects > 0 ? " and pending work" : ""}`
          : state.status === "failed"
            ? " · check deployment logs"
            : " · reconnecting shortly"}
      </p>
      {state.status === "queued" && blockingThreads.length > 0 ? (
        <div className="mt-2 min-w-0">
          <ul id={threadListId} className="max-h-32 overflow-y-auto overscroll-contain">
            {visibleThreads.map((thread) => (
              <li key={thread.threadId} className="min-w-0">
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: thread.threadId }}
                  className="block truncate rounded-sm px-1.5 py-1 text-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  title={thread.title}
                  aria-label={`Open blocking thread: ${thread.title}`}
                >
                  {thread.title}
                </Link>
              </li>
            ))}
          </ul>
          {blockingThreads.length > COLLAPSED_THREAD_LIMIT ? (
            <div className="mt-1">
              <Button
                size="xs"
                variant="ghost-muted"
                aria-expanded={expanded}
                aria-controls={threadListId}
                onClick={() => setExpandedDeploymentId(expanded ? null : state.id)}
              >
                {expanded
                  ? "Show less"
                  : `Show ${blockingThreads.length - COLLAPSED_THREAD_LIMIT} more`}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
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
