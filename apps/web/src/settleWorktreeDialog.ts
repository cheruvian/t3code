import type { VcsStatusLocalResult } from "@t3tools/contracts";

export type SettleWorktreeChoice = "keep" | "delete" | null;
export type SettleWorktreeDecision =
  | { choice: "keep"; removeAutomations: boolean }
  | { choice: "delete"; status: VcsStatusLocalResult; removeAutomations: boolean }
  | null;

export interface SettleWorktreePrompt {
  path: string | null;
  canDelete: boolean;
  loadStatus?: () => Promise<VcsStatusLocalResult>;
  initialStatus?: VcsStatusLocalResult;
}

export interface SettleWorktreeDialogState {
  path: string | null;
  canDelete: boolean;
  phase: "loading" | "ready" | "error";
  status: VcsStatusLocalResult | null;
  removeAutomations: boolean;
}

interface PendingPrompt {
  prompt: SettleWorktreePrompt;
  state: SettleWorktreeDialogState;
  resolve: (decision: SettleWorktreeDecision) => void;
  loadVersion: number;
}

let active: PendingPrompt | null = null;
const queue: PendingPrompt[] = [];
const listeners = new Set<() => void>();
let hostCount = 0;

function publish() {
  for (const listener of listeners) listener();
}

function activate(pending: PendingPrompt) {
  active = pending;
  publish();
  if (pending.state.phase === "loading") void load(pending);
}

async function load(pending: PendingPrompt) {
  const version = ++pending.loadVersion;
  pending.state = { ...pending.state, phase: "loading", status: null };
  publish();
  try {
    if (!pending.prompt.loadStatus) return;
    const status = await pending.prompt.loadStatus();
    if (active !== pending || version !== pending.loadVersion) return;
    pending.state = { ...pending.state, phase: "ready", status };
  } catch {
    if (active !== pending || version !== pending.loadVersion) return;
    pending.state = { ...pending.state, phase: "error", status: null };
  }
  publish();
}

function finish(decision: SettleWorktreeDecision) {
  if (!active) return;
  active.resolve(decision);
  const next = queue.shift();
  if (next) activate(next);
  else {
    active = null;
    publish();
  }
}

export function subscribeSettleWorktreeDialog(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readSettleWorktreeDialog() {
  return active?.state ?? null;
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
  if (hostCount === 0) return Promise.resolve<SettleWorktreeDecision>(null);
  return new Promise<SettleWorktreeDecision>((resolve) => {
    const pending: PendingPrompt = {
      prompt,
      state: {
        path: prompt.path,
        canDelete: prompt.canDelete,
        phase: prompt.initialStatus || !prompt.path ? "ready" : "loading",
        status: prompt.initialStatus ?? null,
        removeAutomations: true,
      },
      resolve,
      loadVersion: 0,
    };
    if (active) queue.push(pending);
    else activate(pending);
  });
}

export function retrySettleWorktreeDialog() {
  if (active?.state.phase === "error") void load(active);
}

export function setSettleDialogRemoveAutomations(removeAutomations: boolean) {
  if (!active) return;
  active.state = { ...active.state, removeAutomations };
  publish();
}

export function respondToSettleWorktreeDialog(choice: SettleWorktreeChoice) {
  if (!active) return;
  if (choice === null) {
    finish(null);
    return;
  }
  if (choice === "keep") {
    finish({ choice: "keep", removeAutomations: active.state.removeAutomations });
    return;
  }
  const { status, phase, canDelete } = active.state;
  if (phase !== "ready" || !status || !canDelete) return;
  finish({ choice: "delete", status, removeAutomations: active.state.removeAutomations });
}
