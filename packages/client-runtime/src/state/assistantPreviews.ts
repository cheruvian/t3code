import type {
  OrchestrationV2AssistantMessageItem,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

const ACTIVE = new Set(["preparing", "starting", "running", "waiting"]);

export function isAssistantPreviewCurrent(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2AssistantMessageItem,
): boolean {
  if (item.threadId !== projection.thread.id || !item.text.trim() || !item.streaming) return false;
  if (
    projection.turnItems.some((stored) => stored.id === item.id) ||
    projection.visibleTurnItems.some((row) => row.sourceItemId === item.id)
  )
    return false;
  const run = projection.runs.find((run) => run.id === item.runId);
  if (run && !ACTIVE.has(run.status)) return false;
  const turn = projection.providerTurns.find((turn) => turn.id === item.providerTurnId);
  return !turn || ACTIVE.has(turn.status);
}

/** Overlay only at the view boundary so snippets never enter cache or reducers. */
export function withAssistantPreviews(
  projection: OrchestrationV2ThreadProjection,
  previews: ReadonlyArray<OrchestrationV2AssistantMessageItem> = [],
): OrchestrationV2ThreadProjection {
  const active = previews.filter((item) => isAssistantPreviewCurrent(projection, item));
  if (active.length === 0) return projection;
  const rows = [...projection.visibleTurnItems];
  let position = rows.reduce((max, row) => Math.max(max, row.position), -1) + 1;
  for (const item of active) {
    const row = {
      position: position++,
      visibility: "local" as const,
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    };
    // Provider ordinals are local to a turn; persisted ordinals are allocated
    // by TurnItemPositionStore. A live snippet follows the durable timeline
    // until its committed item replaces it with a canonical position.
    rows.push(row);
  }
  return { ...projection, turnItems: [...projection.turnItems, ...active], visibleTurnItems: rows };
}
