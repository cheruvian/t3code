import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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

let root: ReactTestRenderer;
let voice: ReturnType<typeof useBrowserDictation>;
let input: Parameters<typeof useBrowserDictation>[0];
const page = new EventTarget();
class Element {
  blur = vi.fn();
}
const editor = new Element();

function Probe() {
  voice = useBrowserDictation(input);
  return null;
}

beforeEach(async () => {
  Recognition.instances = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("HTMLElement", Element);
  vi.stubGlobal("window", { isSecureContext: true, SpeechRecognition: Recognition });
  vi.stubGlobal("document", Object.assign(page, { hidden: false, activeElement: editor }));
  vi.stubGlobal("navigator", { language: "en-US" });
  input = {
    owner: "thread-a",
    prompt: "Existing draft.",
    enabled: true,
    commit: vi.fn(() => true),
  };
  await act(() => {
    root = create(<Probe />);
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("composer dictation ownership", () => {
  it("leaves ordinary draft edits alone and does not request the microphone", async () => {
    input = { ...input, prompt: "Typed message" };
    await act(() => root.update(<Probe />));
    input = { ...input, prompt: "Typed message with another line\nAnd more text." };
    await act(() => root.update(<Probe />));
    expect(Recognition.instances).toHaveLength(0);
    expect(input.commit).not.toHaveBeenCalled();
    expect(voice.busy).toBe(false);
    expect(voice.error).toBeNull();
  });

  it("blurs the editor and delivers a transcript without focusing or sending", async () => {
    await act(() => voice.start());
    expect(editor.blur).toHaveBeenCalled();
    expect(voice.busy).toBe(true);
    await act(() => Recognition.latest.finish("Add tests."));
    expect(input.commit).toHaveBeenCalledExactlyOnceWith("Existing draft.", "Add tests.");
    expect(voice.busy).toBe(false);
  });

  it.each(["owner", "prompt", "enabled"] as const)(
    "cancels when %s changes and discards late results",
    async (field) => {
      await act(() => voice.start());
      const recognition = Recognition.latest;
      input = { ...input, [field]: field === "enabled" ? false : "Changed" };
      await act(() => root.update(<Probe />));
      await act(() => recognition.finish("Stale transcript"));
      expect(recognition.abort).toHaveBeenCalledOnce();
      expect(input.commit).not.toHaveBeenCalled();
      expect(voice.busy).toBe(false);
    },
  );

  it("cancels when the page is hidden", async () => {
    await act(() => voice.start());
    const recognition = Recognition.latest;
    await act(() => {
      Object.assign(page, { hidden: true });
      page.dispatchEvent(new Event("visibilitychange"));
      recognition.finish("Late words");
    });
    expect(input.commit).not.toHaveBeenCalled();
    expect(voice.busy).toBe(false);
  });

  it("explains unavailable recognition instead of starting a recording", async () => {
    vi.stubGlobal("window", { isSecureContext: false });
    await act(() => voice.start());
    expect(voice.error).toContain("HTTPS");
    expect(voice.busy).toBe(false);
  });
});
