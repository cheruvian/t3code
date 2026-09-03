import { useSyncExternalStore } from "react";

let nowSecond = Math.floor(Date.now() / 1_000);
let timerId: number | null = null;
const listeners = new Set<() => void>();

function tick(): void {
  const next = Math.floor(Date.now() / 1_000);
  if (next === nowSecond) return;
  nowSecond = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timerId === null) timerId = window.setInterval(tick, 1_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
  };
}

function getSnapshot(): number {
  if (timerId === null) nowSecond = Math.floor(Date.now() / 1_000);
  return nowSecond;
}

export function useNowSecond(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
