import { DESKTOP_PREVIEW_RENDERING_LEASE } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { installBrowserCaptureActivity } from "./browserCaptureActivity";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";

describe("browser capture activity", () => {
  let dispose: () => void;
  let paint: Array<() => void>;
  const request = (token: string, active: boolean) =>
    (
      globalThis as unknown as Record<
        string,
        (id: number, token: string, active: boolean) => Promise<boolean>
      >
    )[DESKTOP_PREVIEW_RENDERING_LEASE]!(7, token, active);

  beforeEach(() => {
    paint = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => paint.push(callback));
    vi.stubGlobal("document", {
      querySelectorAll: () => [{ getWebContentsId: () => 7, dataset: { previewTab: "guest" } }],
    });
    useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
    dispose = installBrowserCaptureActivity();
  });
  afterEach(() => {
    dispose();
    vi.unstubAllGlobals();
  });

  it("waits for layout and keeps concurrent captures active until each releases", async () => {
    const first = request("first", true);
    const second = request("second", true);
    expect(useBrowserSurfaceStore.getState().activityByTabId.guest).toBe(2);
    paint.splice(0).forEach((callback) => callback());
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    await request("first", false);
    expect(useBrowserSurfaceStore.getState().activityByTabId.guest).toBe(1);
    await request("second", false);
    expect(useBrowserSurfaceStore.getState().activityByTabId.guest).toBeUndefined();
  });

  it("does not reactivate a capture cancelled before layout completes", async () => {
    const pending = request("cancelled", true);
    await request("cancelled", false);
    paint.splice(0).forEach((callback) => callback());
    expect(await pending).toBe(false);
    expect(useBrowserSurfaceStore.getState().activityByTabId.guest).toBeUndefined();
  });

  it("releases pending captures when the host renderer unmounts", async () => {
    const pending = request("unmounted", true);
    dispose();
    paint.splice(0).forEach((callback) => callback());
    expect(await pending).toBe(false);
    expect(useBrowserSurfaceStore.getState().activityByTabId.guest).toBeUndefined();
  });
});
