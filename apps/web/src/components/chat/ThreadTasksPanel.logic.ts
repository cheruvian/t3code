import type { TurnPlanEntry } from "../../session-logic";

/** Only the running turn owns active tasks; unfinished older lists are history too. */
export function partitionThreadTasks(
  plans: readonly TurnPlanEntry[],
  activeRunId: TurnPlanEntry["runId"],
) {
  const active =
    activeRunId === null
      ? null
      : (plans.find(
          (plan) =>
            plan.runId === activeRunId &&
            plan.plan.steps.some((step) => step.status !== "completed"),
        ) ?? null);
  return {
    active,
    history: plans.filter((plan) => plan !== active).toReversed(),
  };
}

/** Use spare space only, leaving the conversation and minimap their own clearance. */
export function resolveThreadTasksGutter(
  chatRight: number,
  containerWidth: number,
  padding: number,
) {
  const width = Math.min(280, containerWidth - chatRight - padding - 48);
  return width >= 220 ? { left: containerWidth - padding - width, width } : null;
}
