import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getAllAudioMuted: vi.fn<() => Promise<boolean>>(),
  setAllAudioMuted: vi.fn<(muted: boolean) => Promise<void>>(),
  onAllAudioMutedChanged: vi.fn<(listener: (muted: boolean) => void) => () => void>(),
  toast: vi.fn(),
}));

vi.mock("~/components/preview/previewBridge", () => ({ previewBridge: mocks }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import { setAllBrowsersMuted, useAllBrowsersMuted } from "./browserAudio";

let renderer: ReactTestRenderer | undefined;
let change: (muted: boolean) => void;
const observed: Record<string, boolean | null> = {};

function AudioReader({ id }: { id: string }) {
  const value = useAllBrowsersMuted();
  useEffect(() => {
    observed[id] = value;
  }, [id, value]);
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAllAudioMuted.mockResolvedValue(false);
  mocks.onAllAudioMutedChanged.mockImplementation((listener) => {
    change = listener;
    return () => undefined;
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
});

describe("app-wide browser audio", () => {
  it("shares authoritative audio changes between controls", async () => {
    await act(() => {
      renderer = create(
        <>
          <AudioReader id="settings" />
          <AudioReader id="tabs" />
        </>,
      );
    });
    expect(observed.settings).toBe(false);
    expect(observed.tabs).toBe(false);
    await act(() => change(true));
    expect(observed.settings).toBe(true);
    expect(observed.tabs).toBe(true);
    await act(() => change(false));
    expect(observed.settings).toBe(false);
    expect(observed.tabs).toBe(false);
  });

  it("does not let a stale initial response overwrite a newer audio event", async () => {
    let resolve!: (muted: boolean) => void;
    mocks.getAllAudioMuted.mockReturnValue(
      new Promise<boolean>((done) => {
        resolve = done;
      }),
    );
    await act(() => {
      renderer = create(<AudioReader id="settings" />);
    });
    expect(observed.settings).toBeNull();
    await act(() => change(true));
    await act(() => resolve(false));
    expect(observed.settings).toBe(true);
  });

  it("keeps the observed state and reports a rejected mute", async () => {
    await act(() => {
      renderer = create(<AudioReader id="settings" />);
    });
    mocks.setAllAudioMuted.mockRejectedValueOnce(new Error("Guest refused to mute"));
    await act(() => setAllBrowsersMuted(true));
    expect(observed.settings).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });
});
