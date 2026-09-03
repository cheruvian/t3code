import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useNowSecond", () => {
  it("shares one timer and tears it down after the last subscriber", async () => {
    let subscribe: ((listener: () => void) => () => void) | undefined;
    const setInterval = vi.fn(() => 42);
    const clearInterval = vi.fn();
    vi.stubGlobal("window", { setInterval, clearInterval });
    vi.doMock("react", () => ({
      useSyncExternalStore: (nextSubscribe: typeof subscribe, getSnapshot: () => number) => {
        subscribe = nextSubscribe;
        return getSnapshot();
      },
    }));

    const { useNowSecond } = await import("./useNowSecond");
    useNowSecond();
    const unsubscribeFirst = subscribe?.(() => undefined);
    const unsubscribeSecond = subscribe?.(() => undefined);

    expect(setInterval).toHaveBeenCalledTimes(1);
    unsubscribeFirst?.();
    expect(clearInterval).not.toHaveBeenCalled();
    unsubscribeSecond?.();
    expect(clearInterval).toHaveBeenCalledWith(42);
  });
});
