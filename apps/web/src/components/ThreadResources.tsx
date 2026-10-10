import { useMemo, useState } from "react";
import { resourceActionLogs, formatResourceActionLog } from "@t3tools/shared/resourceActions";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "./ui/dialog";
import { LockIcon, ScrollTextIcon } from "lucide-react";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "./ui/menu";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { ThreadId } from "@t3tools/contracts";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";

const EMPTY_TURN_ITEMS: readonly OrchestrationV2TurnItem[] = [];

export function ThreadResources({
  project,
  threadId,
  turnItems = EMPTY_TURN_ITEMS,
}: {
  project: EnvironmentProject;
  threadId: ThreadId;
  turnItems?: readonly OrchestrationV2TurnItem[];
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  const logs = useMemo(() => resourceActionLogs(turnItems), [turnItems]);
  const request = useAtomCommand(projectEnvironment.resource);
  const locks = (project.resourceLocks ?? []).filter((lock) => lock.threadId === threadId);
  if (locks.length === 0 && logs.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col" aria-label="Checked out resources">
      {logs.length > 0 && (
        <>
          <ThreadDetailsControl onClick={() => setLogsOpen(true)}>
            <ScrollTextIcon className="text-muted-foreground" />
            Resource logs
          </ThreadDetailsControl>
          <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
            <DialogPopup className="max-w-3xl">
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
        <Menu key={lock.operationId}>
          <MenuTrigger render={<ThreadDetailsControl part="select" />}>
            <LockIcon style={{ color: lock.script.resource?.color }} />
            <span className="min-w-0 flex-1 truncate">{lock.script.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {lock.cancelRequested && (lock.phase === "checkout" || lock.phase === "release")
                ? "Aborting…"
                : lock.phase === "held"
                  ? "Checked out"
                  : lock.phase === "checkout"
                    ? "Checking out…"
                    : lock.phase === "release"
                      ? "Releasing…"
                      : "Failed"}
            </span>
          </MenuTrigger>
          <MenuPopup align="start">
            {lock.error && (
              <div className="max-w-80 whitespace-pre-wrap px-2 py-1 text-xs text-destructive">
                {lock.error}
              </div>
            )}
            {(lock.phase === "checkout" || lock.phase === "release") && (
              <MenuItem
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
              </MenuItem>
            )}
            {(lock.phase === "held" || lock.phase === "failed") && (
              <MenuItem
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
              </MenuItem>
            )}
            {lock.phase === "failed" && (
              <MenuItem
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
              </MenuItem>
            )}
          </MenuPopup>
        </Menu>
      ))}
    </div>
  );
}
