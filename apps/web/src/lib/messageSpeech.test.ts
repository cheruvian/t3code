import { describe, expect, it, vi } from "vite-plus/test";
import {
  MessageSpeechPlayer,
  messageSpeechSections,
  messageSpeechText,
  speechChunks,
  speechFromSection,
} from "./messageSpeech";

describe("message speech", () => {
  it("reads message prose, links, lists and inline code without Markdown syntax", () => {
    expect(
      messageSpeechText(
        "# Result\n\nUse **this** [link](https://example.com) and `vp test`.\n\n- First\n- Second\n\n```ts\nthrow new Error();\n```",
      ),
    ).toBe("Result\nUse this link and vp test.\nFirst\nSecond\n Code block omitted.");
  });

  it("splits long replies without losing or repeating words", () => {
    const text = "A longer message needs multiple utterances. ".repeat(50).trim();
    const chunks = speechChunks(text);
    expect(chunks.every((chunk) => chunk.length <= 220)).toBe(true);
    expect(chunks.join(" ")).toBe(text);
  });

  it("lets a listener read one paragraph or continue from its section", () => {
    const sections = messageSpeechSections(
      "# Summary\n\nFirst **paragraph**.\n\nSecond paragraph with `code`.\n\n- Last item\n\n```ts\nconsole.log('skip');\n```",
    );
    expect(sections.map((section) => section.text)).toEqual([
      "Summary",
      "First paragraph.",
      "Second paragraph with code.",
      "Last item",
      "Code block omitted.",
    ]);
    expect(sections[2]?.text).toBe("Second paragraph with code.");
    expect(speechFromSection(sections, 2)).toBe(
      "Second paragraph with code.\nLast item\nCode block omitted.",
    );
  });

  function setup() {
    const spoken: SpeechSynthesisUtterance[] = [];
    const synthesis = {
      speak: (utterance: SpeechSynthesisUtterance) => spoken.push(utterance),
      cancel: vi.fn(),
      getVoices: () => [],
    };
    const player = new MessageSpeechPlayer(
      synthesis,
      (text) => ({ text, onend: null, onerror: null }) as SpeechSynthesisUtterance,
    );
    return { player, synthesis, spoken };
  }

  it("reads only the requested message and returns to idle after the final chunk", () => {
    const { player, spoken } = setup();
    player.play("reply-a", "First sentence. Second sentence.", "en-US", vi.fn());
    expect(spoken.map((item) => item.text)).toEqual(["First sentence."]);
    spoken[0]!.onend?.({} as SpeechSynthesisEvent);
    expect(spoken.map((item) => item.text)).toEqual(["First sentence.", "Second sentence."]);
    spoken[1]!.onend?.({} as SpeechSynthesisEvent);
    expect(player.getSnapshot()).toBeNull();
  });

  it("switching messages cancels the previous reply and ignores its late completion", () => {
    const { player, spoken, synthesis } = setup();
    player.play("reply-a", "Old first. Old second.", "en-US", vi.fn());
    player.play("reply-b", "New reply.", "en-US", vi.fn());
    spoken[0]!.onend?.({} as SpeechSynthesisEvent);
    player.stop("reply-a");
    expect(player.getSnapshot()).toBe("reply-b");
    expect(spoken.map((item) => item.text)).toEqual(["Old first.", "New reply."]);
    expect(synthesis.cancel).toHaveBeenCalledOnce();
    player.stop("reply-b");
    expect(player.getSnapshot()).toBeNull();
  });

  it("resets the play button and reports synthesis failures", () => {
    const { player, spoken } = setup();
    const error = vi.fn();
    player.play("reply", "Read this.", "en-US", error);
    spoken[0]!.onerror?.({} as SpeechSynthesisErrorEvent);
    expect(player.getSnapshot()).toBeNull();
    expect(error).toHaveBeenCalledOnce();
  });

  it("applies a changed speed to the next sentence and remembers it for later playback", () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value);
      },
    };
    const { synthesis, spoken } = setup();
    const player = new MessageSpeechPlayer(
      synthesis,
      (text) => ({ text, onend: null, onerror: null }) as SpeechSynthesisUtterance,
      storage,
    );
    player.play("reply", "First. Second.", "en-US", vi.fn());
    expect(spoken[0]!.rate).toBe(1);
    player.setRate(2);
    spoken[0]!.onend?.({} as SpeechSynthesisEvent);
    expect(spoken[1]!.rate).toBe(2);
    expect(player.getRateSnapshot()).toBe(2);
    expect(
      new MessageSpeechPlayer(
        synthesis,
        (text) => ({ text }) as SpeechSynthesisUtterance,
        storage,
      ).getRateSnapshot(),
    ).toBe(2);
  });

  it("keeps playback available when speed storage fails", () => {
    const { synthesis, spoken } = setup();
    const player = new MessageSpeechPlayer(
      synthesis,
      (text) => ({ text, onend: null }) as SpeechSynthesisUtterance,
      {
        getItem: () => {
          throw new Error("Storage denied");
        },
        setItem: () => {
          throw new Error("Storage denied");
        },
      },
    );
    player.setRate(2);
    player.play("reply", "Read this.", "en-US", vi.fn());
    expect(spoken[0]!.rate).toBe(2);
  });
});
