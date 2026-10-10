export interface ThreadFeedReturnPosition {
  readonly rowId: string;
  readonly offsetWithinRow: number;
  readonly lastRowId: string;
  readonly atEnd: boolean;
}

const positions = new Map<string, ThreadFeedReturnPosition>();

export function readThreadFeedReturnPosition(threadKey: string) {
  return positions.get(threadKey);
}

export function rememberThreadFeedReturnPosition(
  threadKey: string,
  position: ThreadFeedReturnPosition,
) {
  positions.delete(threadKey);
  positions.set(threadKey, position);
  if (positions.size > 100) {
    const oldest = positions.keys().next().value;
    if (oldest !== undefined) positions.delete(oldest);
  }
}

export function resolveThreadFeedReturnTarget(
  rows: ReadonlyArray<{ readonly id: string }>,
  position: ThreadFeedReturnPosition | undefined,
) {
  if (!position || position.atEnd || position.lastRowId !== rows.at(-1)?.id) return undefined;
  const index = rows.findIndex((row) => row.id === position.rowId);
  return index < 0 ? undefined : { index, viewPosition: 0, viewOffset: -position.offsetWithinRow };
}
