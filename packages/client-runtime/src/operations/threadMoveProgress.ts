import type { ScopedThreadRef } from "@t3tools/contracts";
import { threadMoveProgressDescription, type ThreadMoveProgress } from "./threadMove.ts";

export interface ActiveThreadMove {
  readonly key: string;
  readonly destinationLabel: string;
  readonly description: string;
}

let snapshot: ReadonlyArray<ActiveThreadMove> = [];
const listeners = new Set<() => void>();
const keyFor = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;
const publish = (next: ReadonlyArray<ActiveThreadMove>) => {
  snapshot = next;
  for (const listener of listeners) listener();
};

export const getActiveThreadMoves = () => snapshot;
export const subscribeThreadMoves = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const isThreadMoveInProgress = (ref: ScopedThreadRef) =>
  snapshot.some((move) => move.key === keyFor(ref));

/** Tracks client-owned transfers across navigation and prevents duplicate submissions. */
export function beginThreadMoveProgress(ref: ScopedThreadRef, destinationLabel: string) {
  if (isThreadMoveInProgress(ref)) return null;
  const key = keyFor(ref);
  publish([...snapshot, { key, destinationLabel, description: "Checking both environments…" }]);
  return {
    update(progress: ThreadMoveProgress) {
      const description = threadMoveProgressDescription(progress);
      publish(snapshot.map((move) => (move.key === key ? { ...move, description } : move)));
    },
    finish() {
      publish(snapshot.filter((move) => move.key !== key));
    },
  };
}
