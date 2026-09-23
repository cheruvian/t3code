import { useMemo, useState } from "react";
import { resourceActionLogs, formatResourceActionLog } from "@t3tools/shared/resourceActions";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "./ui/dialog";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { ThreadId } from "@t3tools/contracts";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";

export function ThreadResources({
  project,
  threadId,
  activities = [],
}: {
  project: EnvironmentProject;
  threadId: ThreadId;
  activities?: readonly OrchestrationThreadActivity[];
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  const logs = useMemo(() => resourceActionLogs(activities), [activities]);
  const request = useAtomCommand(projectEnvironment.resource);
  const locks = (project.resourceLocks ?? []).filter((lock) => lock.threadId === threadId);
  if (locks.length === 0 && logs.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-4 py-2" aria-label="Checked out resources">
      {logs.length > 0 && (
        <>
          <Button size="xs" variant="ghost" onClick={() => setLogsOpen(true)}>
            Resource logs
          </Button>
          <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
            <DialogPopup className="max-w-3xl space-y-4 p-6">
              <DialogTitle>Resource action logs</DialogTitle>
              <DialogDescription>
                Checkout and release results for this thread. Output updates while the action runs.
              </DialogDescription>
              <div className="max-h-[65vh] overflow-auto space-y-3">
                {logs.map((log, index) => (
                  <details key={log.operationId} open={index === 0} className="rounded border p-3">
                    <summary className="cursor-pointer text-sm">
                      {log.resourceName} · {log.action} · {log.status}
                    </summary>
                    <pre className="mt-3 whitespace-pre-wrap break-words text-xs select-text">
                      {formatResourceActionLog(log)}
                    </pre>
                  </details>
                ))}
              </div>
            </DialogPopup>
          </Dialog>
        </>
      )}
      {locks.map((lock) => (
        <div
          key={lock.script.id}
          className="flex items-center gap-2 rounded border px-2 py-1 text-xs"
          style={{ borderColor: lock.script.resource?.color }}
        >
          <span>
            {lock.script.name} ·{" "}
            {lock.phase === "held"
              ? "Checked out"
              : lock.phase === "checkout"
                ? "Checking out…"
                : lock.phase === "release"
                  ? "Releasing…"
                  : "Failed"}
          </span>
          {lock.error && (
            <Tooltip>
              <TooltipTrigger
                render={<span className="max-w-80 truncate text-destructive" tabIndex={0} />}
              >
                {lock.error}
              </TooltipTrigger>
              <TooltipPopup className="max-w-96 whitespace-pre-wrap">{lock.error}</TooltipPopup>
            </Tooltip>
          )}
          {(lock.phase === "checkout" || lock.phase === "release") && (
            <Button
              size="xs"
              variant="ghost"
              disabled={lock.cancelRequested}
              onClick={() =>
                void request({
                  environmentId: project.environmentId,
                  input: {
                    projectId: project.id,
                    threadId,
                    script: lock.script,
                    action: "abort",
                    expectedOperationId: lock.operationId,
                  },
                })
              }
            >
              {lock.cancelRequested ? "Aborting…" : "Abort"}
            </Button>
          )}
          {(lock.phase === "held" || lock.phase === "failed") && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void request({
                  environmentId: project.environmentId,
                  input: {
                    projectId: project.id,
                    threadId,
                    script: lock.script,
                    action: "release",
                  },
                })
              }
            >
              Release
            </Button>
          )}
          {lock.phase === "failed" && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void request({
                  environmentId: project.environmentId,
                  input: {
                    projectId: project.id,
                    threadId,
                    script: lock.script,
                    action: "force-release",
                  },
                })
              }
            >
              Force release
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
