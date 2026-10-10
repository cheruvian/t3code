import { useMemo, useState } from "react";
import type { TurnPlanEntry } from "../../session-logic";
import { cn } from "../../lib/utils";
import { useChatCanvas } from "./ChatCanvasContext";
import { ComposerTasksContent } from "./ComposerTasksBadge";
import { partitionThreadTasks, resolveThreadTasksGutter } from "./ThreadTasksPanel.logic";

function TaskList({ entry, active }: { entry: TurnPlanEntry; active: boolean }) {
  const [expanded, setExpanded] = useState(active);
  const { steps, explanation } = entry.plan;
  const current =
    steps.find((step) => step.status === "inProgress") ??
    steps.find((step) => step.status === "pending") ??
    steps.at(-1);
  if (!current) return null;
  return (
    <div className="min-w-0 rounded-lg border border-border/60 p-1">
      <ComposerTasksContent
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
        progress={{
          step: current.step,
          completedSteps: steps.filter((step) => step.status === "completed").length,
          totalSteps: steps.length,
        }}
        steps={steps}
      />
      {expanded && explanation ? (
        <p className="px-2 pb-1 text-xs text-muted-foreground wrap-anywhere">{explanation}</p>
      ) : null}
    </div>
  );
}

/** Task history stays available without accumulating rows in the conversation. */
export function ThreadTasksPanel({
  plans,
  activeRunId,
}: {
  plans: readonly TurnPlanEntry[];
  activeRunId: TurnPlanEntry["runId"];
}) {
  const canvas = useChatCanvas();
  const { active, history } = useMemo(
    () => partitionThreadTasks(plans, activeRunId),
    [plans, activeRunId],
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(20);
  const availableGutter = canvas
    ? resolveThreadTasksGutter(
        canvas.layout.chat.left + canvas.layout.chat.width,
        canvas.container.width,
        canvas.lane.padding,
      )
    : null;
  const frame = canvas?.layout.frame;
  const gutterHeight =
    availableGutter && frame && frame.x + frame.width > availableGutter.left
      ? frame.y - 24
      : (canvas?.container.height ?? 0) - 24;
  const gutter = gutterHeight >= 160 ? availableGutter : null;
  if (!active && history.length === 0) return null;
  return (
    <aside
      aria-label="Thread tasks"
      data-thread-tasks-placement={gutter ? "gutter" : "inline"}
      className={cn(
        "z-20 min-w-0 shrink-0",
        gutter
          ? "absolute top-3 overflow-y-auto overscroll-contain"
          : "chat-composer-lane max-h-64 overflow-y-auto overscroll-contain py-2",
      )}
      style={
        gutter ? { left: gutter.left, width: gutter.width, maxHeight: gutterHeight } : undefined
      }
    >
      <div
        className={cn(
          "space-y-2 rounded-xl border border-border/60 bg-card p-2 text-xs",
          !gutter && "mx-auto w-full max-w-(--chat-content-max-width)",
        )}
      >
        {active ? (
          <TaskList
            key={`${active.id}:active:${gutter ? "gutter" : "inline"}`}
            entry={active}
            active={Boolean(gutter)}
          />
        ) : null}
        {history.length > 0 ? (
          <details
            open={historyOpen}
            onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer px-2 py-1 text-muted-foreground">
              Task history <span className="tabular-nums">({history.length})</span>
            </summary>
            {historyOpen ? (
              <div className="mt-2 space-y-2">
                {history.slice(0, historyLimit).map((entry) => (
                  <TaskList key={entry.id} entry={entry} active={false} />
                ))}
                {history.length > historyLimit ? (
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1 text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setHistoryLimit((limit) => limit + 20)}
                  >
                    Show older tasks
                  </button>
                ) : null}
              </div>
            ) : null}
          </details>
        ) : null}
      </div>
    </aside>
  );
}
