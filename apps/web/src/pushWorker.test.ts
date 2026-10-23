// @effect-diagnostics nodeBuiltinImport:off - Execute the shipped service worker in a sandbox with browser event fixtures.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

const source = NodeFS.readFileSync(new URL("../public/push-sw.js", import.meta.url), "utf8");

function worker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn(() => Promise.resolve());
  const focus = vi.fn(() => Promise.resolve());
  const navigate = vi.fn(() => Promise.resolve({ focus }));
  const windows: Array<{ url: string; navigate: typeof navigate; focus: typeof focus }> = [];
  const openWindow = vi.fn(() => Promise.resolve());
  NodeVM.runInNewContext(source, {
    URL,
    self: {
      location: { origin: "https://t3.example" },
      addEventListener: (type: string, handler: (event: unknown) => void) =>
        handlers.set(type, handler),
      registration: { showNotification },
      clients: { matchAll: () => Promise.resolve(windows), openWindow },
    },
  });
  const dispatch = (type: string, event: object) =>
    new Promise<void>((resolve, reject) => {
      handlers.get(type)?.({
        ...event,
        waitUntil: (effect: Promise<void>) => effect.then(resolve, reject),
      });
    });
  return { showNotification, focus, navigate, windows, openWindow, dispatch };
}

describe("push service worker", () => {
  it("displays push and opens the correct thread when the app is closed", async () => {
    const w = worker();
    await w.dispatch("push", {
      data: {
        json: () => ({
          title: "Approval needed",
          body: "Fix login",
          tag: "env:thread",
          url: "/env/thread",
        }),
      },
    });
    expect(w.showNotification).toHaveBeenCalledWith(
      "Approval needed",
      expect.objectContaining({
        body: "Fix login",
        data: { url: "https://t3.example/env/thread" },
      }),
    );
    await w.dispatch("notificationclick", {
      notification: { close: vi.fn(), data: { url: "https://t3.example/env/thread" } },
    });
    expect(w.openWindow).toHaveBeenCalledWith("https://t3.example/env/thread");
  });

  it("reuses the app for thread links and opens external HTTPS links separately", async () => {
    const w = worker();
    w.windows.push({
      url: "https://t3.example/settings/general",
      navigate: w.navigate,
      focus: w.focus,
    });
    await w.dispatch("notificationclick", {
      notification: { close: vi.fn(), data: { url: "https://t3.example/env/thread" } },
    });
    expect(w.navigate).toHaveBeenCalledWith("https://t3.example/env/thread");
    expect(w.focus).toHaveBeenCalledOnce();
    expect(w.openWindow).not.toHaveBeenCalled();
    await w.dispatch("notificationclick", {
      notification: { close: vi.fn(), data: { url: "https://elsewhere.example/" } },
    });
    expect(w.navigate).toHaveBeenCalledOnce();
    expect(w.openWindow).toHaveBeenCalledWith("https://elsewhere.example/");
  });

  it("still displays an alert for malformed payloads and neutralizes unsafe URLs", async () => {
    const w = worker();
    await w.dispatch("push", {
      data: {
        json: () => {
          throw new Error("invalid JSON");
        },
      },
    });
    expect(w.showNotification).toHaveBeenCalledWith(
      "T3 Code",
      expect.objectContaining({ body: "A thread needs your attention." }),
    );
    await w.dispatch("push", { data: { json: () => ({ url: "//elsewhere.example/" }) } });
    expect(w.showNotification).toHaveBeenLastCalledWith(
      "T3 Code",
      expect.objectContaining({ data: { url: "https://t3.example/" } }),
    );
  });
});

it.each([
  "javascript:alert(1)",
  "http://elsewhere.example/",
  "https://user:secret@elsewhere.example/",
  "//elsewhere.example/",
])("does not follow unsafe notification links: %s", async (url) => {
  const w = worker();
  await w.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url } } });
  expect(w.openWindow).toHaveBeenCalledWith("https://t3.example/");
});

it.each([true, false])(
  "passes the thread sound preference to system notification delivery: silent=%s",
  async (silent) => {
    const w = worker();
    await w.dispatch("push", { data: { json: () => ({ title: "Thread completed", silent }) } });
    expect(w.showNotification).toHaveBeenCalledWith(
      "Thread completed",
      expect.objectContaining({ silent }),
    );
  },
);
