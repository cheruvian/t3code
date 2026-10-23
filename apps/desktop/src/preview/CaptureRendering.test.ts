import { describe, expect, it, vi } from "vite-plus/test";

import { withCaptureRendering } from "./CaptureRendering.ts";

const fixture = () => {
  let active = false;
  const host = {
    isDestroyed: () => false,
    executeJavaScript: vi.fn(async (expression: string) => {
      active = expression.includes(", true)");
      return true;
    }),
  };
  return {
    guest: { id: 7, hostWebContents: host } as unknown as Electron.WebContents,
    active: () => active,
    host,
  };
};

describe("native capture rendering lease", () => {
  it.each([false, true])("releases the rendering lease after capture failure=%s", async (fail) => {
    const test = fixture();
    const capture = withCaptureRendering(
      test.guest,
      async () => {
        expect(test.active()).toBe(true);
        if (fail) throw new Error("Fixture capture failed");
        return "captured";
      },
      new AbortController().signal,
    );
    if (fail) await expect(capture).rejects.toThrow("Fixture capture failed");
    else await expect(capture).resolves.toBe("captured");
    expect(test.active()).toBe(false);
  });

  it("releases rendering when a disconnected caller cancels a stalled capture", async () => {
    const test = fixture();
    const entered = Promise.withResolvers<void>();
    const frame = Promise.withResolvers<string>();
    const controller = new AbortController();
    const pending = withCaptureRendering(
      test.guest,
      () => {
        entered.resolve();
        return frame.promise;
      },
      controller.signal,
    );
    await entered.promise;
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(test.active()).toBe(false);
    frame.resolve("late frame");
  });

  it("does not start capture if the renderer is unavailable", async () => {
    const test = fixture();
    test.host.executeJavaScript.mockResolvedValue(false);
    const capture = vi.fn(async () => "frame");
    await expect(
      withCaptureRendering(test.guest, capture, new AbortController().signal),
    ).rejects.toThrow("renderer is unavailable");
    expect(capture).not.toHaveBeenCalled();
  });
});
