import {
  AuthPreviewOperateScope,
  type BrowserLinkTarget,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { readEnvironmentScope } from "~/state/session";
import { isPreviewAvailableFor } from "./previewRuntime";

export interface ResolveLinkTargetInput {
  readonly url: string;
  /** Cmd/Ctrl-click and middle-click always go to the system browser, whatever the default. */
  readonly event: {
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly button?: number | undefined;
  };
  readonly preference: BrowserLinkTarget;
  /** Whether this client has an in-app browser and a thread to open it beside. */
  readonly canOpenInApp: boolean;
}

/**
 * Use the in-app target only for supported URLs and runtimes when requested or in a Home Screen app.
 * Modifiers retain a one-gesture escape to external browsing.
 */
export function resolveLinkTarget(input: ResolveLinkTargetInput): BrowserLinkTarget {
  if (input.event.metaKey || input.event.ctrlKey || input.event.button === 1) return "system";
  if (input.preference !== "app" && !isStandaloneWebApp()) return "system";
  if (!input.canOpenInApp) return "system";
  if (!isWebUrl(input.url)) return "system";
  return "app";
}

/** Home Screen apps have no browser Back control if an external page replaces them. */
export function isStandaloneWebApp(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches === true ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true)
  );
}

/**
 * Only http(s) can load in the in-app browser. Anything else — mailto:,
 * vscode://, a bare fragment — belongs to the shell whatever the preference.
 */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Before hydration, the default "system" would ignore a saved "app" link target. */
export async function resolveBrowserLinkTargetPreference(): Promise<BrowserLinkTarget> {
  await ensureClientSettingsHydrated();
  return getClientSettings().browserLinkTarget;
}

/** Whether this thread's environment has an in-app browser available to this client. */
export function canOpenLinksInApp(threadRef: ScopedThreadRef | null | undefined): boolean {
  return (
    threadRef != null &&
    readEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope) &&
    isPreviewAvailableFor(threadRef.environmentId)
  );
}
