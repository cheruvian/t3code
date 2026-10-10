import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BrowserDictation, type BrowserRecognition } from "./browserDictation";

function setup() {
  const callbacks = { phase: vi.fn(), preview: vi.fn(), commit: vi.fn(), error: vi.fn() };
  const recognition: BrowserRecognition = {
    lang: "",
    continuous: false,
    interimResults: false,
    onstart: null,
    onend: null,
    onerror: null,
    onresult: null,
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
  };
  const controller = new BrowserDictation(callbacks);
  controller.start(recognition, "en-US");
  return { controller, recognition, callbacks };
}

afterEach(() => vi.useRealTimers());

describe("browser dictation", () => {
  it("previews interim words but commits final results only after recognition ends", () => {
    const { controller, recognition, callbacks } = setup();
    recognition.onresult?.({
      results: [
        { isFinal: true, 0: { transcript: "Fix the tests." } },
        { isFinal: false, 0: { transcript: "Maybe" } },
      ],
    });
    expect(callbacks.preview).toHaveBeenLastCalledWith("Fix the tests. Maybe");
    expect(callbacks.commit).not.toHaveBeenCalled();
    controller.stop();
    expect(callbacks.commit).not.toHaveBeenCalled();
    recognition.onend?.();
    expect(callbacks.commit).toHaveBeenCalledExactlyOnceWith("Fix the tests.");
    expect(callbacks.phase).toHaveBeenLastCalledWith("idle");
  });

  it("discards late results after cancellation, including after a new recording starts", () => {
    const { controller, recognition, callbacks } = setup();
    controller.cancel();
    recognition.onresult?.({ results: [{ isFinal: true, 0: { transcript: "Wrong thread" } }] });
    recognition.onend?.();
    expect(callbacks.commit).not.toHaveBeenCalled();
    expect(recognition.abort).toHaveBeenCalledOnce();
  });

  it("does not duplicate final results repeated in the browser's cumulative result list", () => {
    const { recognition, callbacks } = setup();
    const first = { isFinal: true, 0: { transcript: "First." } };
    recognition.onresult?.({ results: [first] });
    recognition.onresult?.({ results: [first, { isFinal: true, 0: { transcript: "Second." } }] });
    recognition.onend?.();
    expect(callbacks.commit).toHaveBeenCalledExactlyOnceWith("First. Second.");
  });

  it("releases the session on permission denial without committing earlier text", () => {
    const { recognition, callbacks } = setup();
    recognition.onresult?.({ results: [{ isFinal: true, 0: { transcript: "Partial" } }] });
    recognition.onerror?.({ error: "not-allowed" });
    recognition.onend?.();
    expect(callbacks.commit).not.toHaveBeenCalled();
    expect(callbacks.error).toHaveBeenCalledWith(expect.stringContaining("denied"));
    expect(callbacks.phase).toHaveBeenLastCalledWith("idle");
  });

  it("recovers if the browser never finishes after stop", () => {
    vi.useFakeTimers();
    const { controller, callbacks, recognition } = setup();
    controller.stop();
    vi.advanceTimersByTime(10_000);
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(callbacks.phase).toHaveBeenLastCalledWith("idle");
    expect(callbacks.error).toHaveBeenCalledWith(expect.stringContaining("did not finish"));
  });
});
