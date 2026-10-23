import type { EnvironmentId, WebPushSubscription } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { isElectron } from "./env";

const CHANGE_EVENT = "t3-push-settings-change";
const preferenceKey = (environmentId: EnvironmentId) => `t3:push:${environmentId}`;
// Each environment has its own VAPID key; a worker registration can hold only one subscription.
const workerScope = (environmentId: EnvironmentId) => `/push/${encodeURIComponent(environmentId)}/`;

export function webPushAvailability(): string | null {
  if (isElectron) return "Use thread notifications in the desktop app.";
  if (!window.isSecureContext) return "Background push requires HTTPS.";
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return "On iPhone or iPad, add T3 Code to your Home Screen and open it there. Otherwise, use a browser that supports Web Push.";
  }
  return null;
}

export function isWebPushEnabled(environmentId: EnvironmentId): boolean {
  try {
    return localStorage.getItem(preferenceKey(environmentId)) === "enabled";
  } catch {
    return false;
  }
}

export function setWebPushEnabled(environmentId: EnvironmentId, enabled: boolean) {
  if (enabled) localStorage.setItem(preferenceKey(environmentId), "enabled");
  else localStorage.removeItem(preferenceKey(environmentId));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(listener: () => void) {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function useWebPushEnabled(environmentId: EnvironmentId) {
  return useSyncExternalStore(
    subscribe,
    () => isWebPushEnabled(environmentId),
    () => false,
  );
}

export async function getWebPushSubscription(environmentId: EnvironmentId) {
  if (webPushAvailability() !== null) return null;
  const scope = new URL(workerScope(environmentId), window.location.origin).href;
  const registration = (await navigator.serviceWorker.getRegistrations()).find(
    (candidate) => candidate.scope === scope,
  );
  return registration?.pushManager.getSubscription() ?? null;
}

export async function subscribeWebPush(environmentId: EnvironmentId, publicKey: string) {
  const registration = await navigator.serviceWorker.register("/push-sw.js", {
    scope: workerScope(environmentId),
    updateViaCache: "none",
  });
  if (!registration.active) {
    const worker = registration.installing ?? registration.waiting;
    if (worker)
      await new Promise<void>((resolve, reject) => {
        const changed = () => {
          if (worker.state === "activated") {
            worker.removeEventListener("statechange", changed);
            resolve();
          }
          if (worker.state === "redundant") {
            worker.removeEventListener("statechange", changed);
            reject(new Error("The notification service could not start."));
          }
        };
        worker.addEventListener("statechange", changed);
        changed();
      });
  }
  const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
    char.charCodeAt(0),
  );
  const existing = await registration.pushManager.getSubscription();
  if (
    existing &&
    existing.options.applicationServerKey &&
    Array.from(new Uint8Array(existing.options.applicationServerKey)).join() !==
      Array.from(bytes).join()
  ) {
    await existing.unsubscribe();
  }
  return (
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: bytes,
    }))
  );
}

export function serializeWebPushSubscription(subscription: PushSubscription): WebPushSubscription {
  const json = subscription.toJSON();
  if (!json.keys?.p256dh || !json.keys.auth)
    throw new Error("The browser did not provide push encryption keys.");
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}
