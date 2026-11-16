import { useLayoutEffect } from "react";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BrowserRecognition } from "~/lib/browserDictation";
import { useBrowserDictation } from "./useBrowserDictation";

vi.mock("~/lib/messageSpeech", () => ({ getMessageSpeechPlayer: () => null }));

class Recognition implements BrowserRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: BrowserRecognition["onstart"] = null;
  onend: BrowserRecognition["onend"] = null;
  onerror: BrowserRecognition["onerror"] = null;
  onresult: BrowserRecognition["onresult"] = null;
  static latest: Recognition;
  static instances: Recognition[] = [];
  constructor() {
    Recognition.latest = this;
    Recognition.instances.push(this);
  }
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn();
  abort = vi.fn();
  finish(text: string) {
    this.onresult?.({ results: [{ isFinal: true, 0: { transcript: text } }] });
    this.onend?.();
  }
}

let voice: ReturnType<typeof useBrowserDictation>;
let input: Parameters<typeof useBrowserDictation>[0];
let editor: HTMLTextAreaElement;

function Probe({ input }: { input: Parameters<typeof useBrowserDictation>[0] }) {
  const current = useBrowserDictation(input);
  useLayoutEffect(() => {
    voice = current;
  });
  return null;
}

describe("composer dictation ownership", () => {
  it("leaves ordinary draft edits alone and does not request the microphone", async () => {
    using _fixture = setup();
    await using screen = await render(<Probe input={input} />, { router: false });
    input = { ...input, prompt: "Typed message" };
    await screen.rerender(<Probe input={input} />);
    input = { ...input, prompt: "Typed message with another line\nAnd more text." };
    await screen.rerender(<Probe input={input} />);
    expect(Recognition.instances).toHaveLength(0);
    expect(input.commit).not.toHaveBeenCalled();
    expect(voice.busy).toBe(false);
    expect(voice.error).toBeNull();
  });

  it("blurs the editor and delivers a transcript without focusing or sending", async () => {
    using _fixture = setup();
    await using _screen = await render(<Probe input={input} />, { router: false });
    await act(() => voice.start());
    expect(editor.blur).toHaveBeenCalled();
    expect(voice.busy).toBe(true);
    await act(() => Recognition.latest.finish("Add tests."));
    expect(input.commit).toHaveBeenCalledExactlyOnceWith("Existing draft.", "Add tests.");
    expect(voice.busy).toBe(false);
  });

  it("finishes and commits the final transcript before submitting once", async () => {
    using _fixture = setup();
    await using _screen = await render(<Probe input={input} />, { router: false });
    const submit = vi.fn(() => {
      expect(input.commit).toHaveBeenCalledExactlyOnceWith("Existing draft.", "Final words.");
    });
    await act(() => voice.start());
    await act(() => {
      voice.stopAndSubmit(submit);
      voice.stopAndSubmit(submit);
    });
    expect(Recognition.latest.stop).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    await act(() => voice.stopAndSubmit(submit));
    expect(Recognition.latest.stop).toHaveBeenCalledOnce();
    await act(() => Recognition.latest.finish("Final words."));
    expect(submit).toHaveBeenCalledOnce();
  });

  it("does not submit when dictation is cancelled or fails", async () => {
    using _fixture = setup();
    await using _screen = await render(<Probe input={input} />, { router: false });
    const submit = vi.fn();
    await act(() => voice.start());
    const cancelled = Recognition.latest;
    await act(() => voice.stopAndSubmit(submit));
    await act(() => voice.cancel());
    await act(() => cancelled.finish("Discarded"));
    await act(() => voice.start());
    await act(() => voice.stopAndSubmit(submit));
    await act(() => Recognition.latest.onerror?.({ error: "not-allowed" }));
    expect(input.commit).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not submit an empty transcript or a rejected draft", async () => {
    using _fixture = setup();
    await using screen = await render(<Probe input={input} />, { router: false });
    const submit = vi.fn();
    await act(() => voice.start());
    await act(() => voice.stopAndSubmit(submit));
    await act(() => Recognition.latest.finish(""));
    expect(submit).not.toHaveBeenCalled();
    input = { ...input, commit: vi.fn(() => false) };
    await screen.rerender(<Probe input={input} />);
    await act(() => voice.start());
    await act(() => voice.stopAndSubmit(submit));
    await act(() => Recognition.latest.finish("Rejected"));
    expect(submit).not.toHaveBeenCalled();
    expect(voice.error).toContain("draft changed");
  });

  it.each(["owner", "prompt", "enabled"] as const)(
    "cancels when %s changes and discards late results",
    async (field) => {
      using _fixture = setup();
      await using screen = await render(<Probe input={input} />, { router: false });
      await act(() => voice.start());
      const recognition = Recognition.latest;
      input = { ...input, [field]: field === "enabled" ? false : "Changed" };
      await screen.rerender(<Probe input={input} />);
      await act(() => recognition.finish("Stale transcript"));
      expect(recognition.abort).toHaveBeenCalledOnce();
      expect(input.commit).not.toHaveBeenCalled();
      expect(voice.busy).toBe(false);
    },
  );

  it("cancels when the page is hidden", async () => {
    using _fixture = setup();
    await using _screen = await render(<Probe input={input} />, { router: false });
    await act(() => voice.start());
    const recognition = Recognition.latest;
    await act(() => {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
      recognition.finish("Late words");
    });
    expect(input.commit).not.toHaveBeenCalled();
    expect(voice.busy).toBe(false);
  });

  it("explains unavailable recognition instead of starting a recording", async () => {
    using _fixture = setup();
    await using _screen = await render(<Probe input={input} />, { router: false });
    vi.stubGlobal("isSecureContext", false);
    await act(() => voice.start());
    expect(voice.error).toContain("HTTPS");
    expect(voice.busy).toBe(false);
  });
});

function setup() {
  Recognition.instances = [];
  vi.stubGlobal("SpeechRecognition", Recognition);
  vi.stubGlobal("isSecureContext", true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  editor = document.createElement("textarea");
  document.body.append(editor);
  editor.focus();
  vi.spyOn(editor, "blur");
  input = {
    owner: "thread-a",
    prompt: "Existing draft.",
    enabled: true,
    commit: vi.fn(() => true),
  };
  return {
    [Symbol.dispose]() {
      editor.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    },
  };
}
