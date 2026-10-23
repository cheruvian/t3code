import { DESKTOP_PREVIEW_RENDERING_LEASE } from "@t3tools/contracts";
import { flushSync } from "react-dom";

import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";

/** Native capture uses this host-renderer hook, never the guest's page script. */
export function installBrowserCaptureActivity() {
  const leases = new Map<string, () => void>();
  const request = async (webContentsId: number, token: string, active: boolean) => {
    if (!active) {
      const release = leases.get(token);
      leases.delete(token);
      if (release) flushSync(release);
      return true;
    }
    if (leases.has(token)) return true;
    const guest = [...document.querySelectorAll("webview")].find((element) => {
      try {
        return element.getWebContentsId() === webContentsId;
      } catch {
        return false;
      }
    });
    const tabId = guest?.dataset.previewTab;
    if (!tabId) return false;
    flushSync(() => leases.set(token, acquireBrowserSurfaceActivity(tabId)));
    // React has placed the guest behind the app; let Chromium commit that layout.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return leases.has(token);
  };
  const host = globalThis as typeof globalThis & {
    [DESKTOP_PREVIEW_RENDERING_LEASE]?: typeof request;
  };
  host[DESKTOP_PREVIEW_RENDERING_LEASE] = request;
  return () => {
    if (host[DESKTOP_PREVIEW_RENDERING_LEASE] === request)
      delete host[DESKTOP_PREVIEW_RENDERING_LEASE];
    for (const release of leases.values()) release();
    leases.clear();
  };
}
