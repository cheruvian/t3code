import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  RunId,
} from "@t3tools/contracts";
import type { InlineSkill } from "@t3tools/shared/inlineSkills";
import { searchableMessageSegments, searchablePlanSegments } from "@t3tools/shared/threadFindText";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";

export type ThreadFindStart = NonNullable<OrchestrationV2SearchThreadInput["start"]>;
export type ThreadFindPositionReader = (query: string) => ThreadFindStart | undefined;

/** One occurrence of the query inside a searchable timeline entry. */
export interface ThreadFindMatch {
  readonly entryId: string;
  /** The turn to expand when the matching entry is folded. */
  readonly runId: RunId | null;
  /** Zero-based occurrence within this timeline entry. */
  readonly occurrence: number;
}

function clampThreadFindIndex(index: number, total: number): number {
  if (total <= 0 || !Number.isFinite(index) || index < 0) return 0;
  return Math.min(Math.trunc(index), total - 1);
}

export function stepThreadFindIndex(index: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  const clamped = clampThreadFindIndex(index, total);
  return (((clamped + delta) % total) + total) % total;
}

export function formatThreadFindCount(index: number, total: number): string {
  return total <= 0 ? "0/0" : `${clampThreadFindIndex(index, total) + 1}/${total}`;
}

/** Search loaded history when the environment has no server-side find API. */
export function findLoadedThreadItems(
  items: readonly OrchestrationV2ProjectedTurnItem[],
  query: string,
  start: ThreadFindStart | undefined,
  offset: number,
  skills: readonly InlineSkill[],
): OrchestrationV2SearchThreadResult {
  const needle = query.trim();
  let totalMatches = 0;
  const foldedAnswers = new Set(
    items.flatMap(({ item }) =>
      item.type === "user_input_request" && item.questionAnswer
        ? [`async-answer:${item.questionAnswer.requestId}`]
        : [],
    ),
  );
  const navigation = needle
    ? items.flatMap(({ item }) => {
        if (
          item.type !== "user_message" &&
          item.type !== "assistant_message" &&
          item.type !== "proposed_plan"
        )
          return [];
        if (item.type === "user_message" && foldedAnswers.has(item.messageId)) return [];
        const segments =
          item.type === "proposed_plan"
            ? searchablePlanSegments(item.markdown)
            : (searchableMessageSegments(
                {
                  role: item.type === "user_message" ? "user" : "assistant",
                  text: item.text,
                  streaming: item.type === "assistant_message" && item.streaming,
                  context: item.type === "user_message" ? item.context : undefined,
                },
                undefined,
                skills,
              ) ?? []);
        const count = segments.reduce(
          (sum, text) => sum + countThreadSearchOccurrences(text, needle),
          0,
        );
        const entry = {
          entryId: item.type === "proposed_plan" ? item.id : item.messageId,
          runId: item.runId,
          startIndex: totalMatches,
          count,
        };
        totalMatches += count;
        return count > 0 ? [entry] : [];
      })
    : [];
  const anchor = navigation.find((entry) => entry.entryId === start?.entryId);
  const anchorIndex = anchor
    ? anchor.startIndex + Math.min(start!.occurrence, anchor.count - 1)
    : 0;
  const activeIndex = stepThreadFindIndex(anchorIndex, totalMatches, offset);
  const selectedIndex = navigation.findIndex(
    (entry) => activeIndex >= entry.startIndex && activeIndex < entry.startIndex + entry.count,
  );
  const selected = navigation[selectedIndex];
  return {
    complete: true,
    snapshotSequence: 0,
    totalMatches,
    activeIndex,
    match: selected
      ? {
          entryId: selected.entryId,
          runId: selected.runId,
          occurrence: activeIndex - selected.startIndex,
        }
      : null,
    navigation: navigation.slice(
      Math.max(0, selectedIndex - 8),
      Math.max(0, selectedIndex - 8) + 17,
    ),
  };
}
