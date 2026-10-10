import { useSyncExternalStore } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { toastManager } from "~/components/ui/toast";

let muted: boolean | null = null;
let generation = 0;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function publish(next: boolean) {
  generation += 1;
  muted = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (previewBridge && !unsubscribe) {
    unsubscribe = previewBridge.onAllAudioMutedChanged(publish);
    const requestGeneration = generation;
    void previewBridge
      .getAllAudioMuted()
      .then((next) => {
        if (generation === requestGeneration) publish(next);
      })
      .catch(reportError);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribe?.();
      unsubscribe = null;
      generation += 1;
      muted = null;
    }
  };
}

function reportError(error: unknown) {
  toastManager.add({
    type: "error",
    title: "Could not change browser audio",
    description: error instanceof Error ? error.message : "Try again.",
  });
}

export function useAllBrowsersMuted() {
  return useSyncExternalStore(
    subscribe,
    () => muted,
    () => null,
  );
}

export async function setAllBrowsersMuted(next: boolean) {
  if (!previewBridge) return;
  try {
    await previewBridge.setAllAudioMuted(next);
  } catch (error) {
    reportError(error);
  }
}

export async function toggleAllBrowsersMuted() {
  if (!previewBridge) return;
  try {
    const current = await previewBridge.getAllAudioMuted();
    await previewBridge.setAllAudioMuted(!current);
  } catch (error) {
    reportError(error);
  }
}
