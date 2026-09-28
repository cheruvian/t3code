export type SettleWorktreeChoice = "keep" | "delete" | null;

export interface SettleWorktreePrompt {
  path: string;
  files: ReadonlyArray<{ path: string; insertions: number; deletions: number }>;
  insertions: number;
  deletions: number;
  canDelete: boolean;
}

interface PendingPrompt {
  prompt: SettleWorktreePrompt;
  resolve: (choice: SettleWorktreeChoice) => void;
}

let active: PendingPrompt | null = null;
const queue: PendingPrompt[] = [];
const listeners = new Set<() => void>();
let hostCount = 0;

function publish() {
  for (const listener of listeners) listener();
}

export function subscribeSettleWorktreeDialog(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readSettleWorktreeDialog() {
  return active?.prompt ?? null;
}

export function registerSettleWorktreeDialog() {
  hostCount++;
  return () => {
    hostCount--;
    if (hostCount === 0) {
      active?.resolve(null);
      active = null;
      for (const pending of queue.splice(0)) pending.resolve(null);
      publish();
    }
  };
}

export function requestSettleWorktreeDialog(prompt: SettleWorktreePrompt) {
  if (hostCount === 0) return Promise.resolve<SettleWorktreeChoice>(null);
  return new Promise<SettleWorktreeChoice>((resolve) => {
    const pending = { prompt, resolve };
    if (active) queue.push(pending);
    else {
      active = pending;
      publish();
    }
  });
}

export function respondToSettleWorktreeDialog(choice: SettleWorktreeChoice) {
  if (!active) return;
  active.resolve(choice);
  active = queue.shift() ?? null;
  publish();
}
