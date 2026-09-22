import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { ThreadId } from "@t3tools/contracts";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";

export function ThreadResources({
  project,
  threadId,
}: {
  project: EnvironmentProject;
  threadId: ThreadId;
}) {
  const request = useAtomCommand(projectEnvironment.resource);
  const locks = (project.resourceLocks ?? []).filter((lock) => lock.threadId === threadId);
  if (locks.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-4 py-2" aria-label="Checked out resources">
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
