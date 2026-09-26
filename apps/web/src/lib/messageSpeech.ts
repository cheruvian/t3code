import type { Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";

const parser = unified().use(remarkParse).use(remarkGfm);

/** Read prose and inline code, without Markdown punctuation or fenced code dumps. */
export function messageSpeechText(markdown: string): string {
  const read = (node: Root | RootContent): string => {
    if (node.type === "code") return " Code block omitted. ";
    if (node.type === "html" || node.type === "definition") return "";
    if ("alt" in node) return node.alt ?? "";
    if ("value" in node) return node.value;
    if ("children" in node) {
      const block = ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(
        node.type,
      );
      return node.children.map(read).join(block ? "\n" : "");
    }
    return node.type === "break" ? "\n" : "";
  };
  return read(parser.parse(markdown))
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function speechChunks(text: string): string[] {
  // Short utterances avoid browser length limits; keep sentence boundaries when possible.
  const sentences = text.match(/[^.!?\n]+[.!?]*(?:\s+|$)|[^\n]+/g) ?? [];
  return sentences.flatMap((sentence) => {
    const chunks: string[] = [];
    let remaining = sentence.trim();
    while (remaining.length > 220) {
      const space = remaining.lastIndexOf(" ", 220);
      const boundary = space > 0 ? space : 220;
      chunks.push(remaining.slice(0, boundary));
      remaining = remaining.slice(boundary).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  });
}

export class MessageSpeechPlayer {
  private active: { owner: string; utterance: SpeechSynthesisUtterance | null } | null = null;
  private listeners = new Set<() => void>();
  constructor(
    private readonly synthesis: Pick<SpeechSynthesis, "speak" | "cancel" | "getVoices">,
    private readonly createUtterance: (text: string) => SpeechSynthesisUtterance,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.active?.owner ?? null;
  stop = (owner?: string) => {
    if (!this.active || (owner !== undefined && this.active.owner !== owner)) return;
    this.active = null;
    this.synthesis.cancel();
    this.listeners.forEach((listener) => listener());
  };
  play(owner: string, text: string, language: string, onError: () => void) {
    this.stop();
    const chunks = speechChunks(messageSpeechText(text));
    if (chunks.length === 0) return;
    const session = { owner, utterance: null as SpeechSynthesisUtterance | null };
    this.active = session;
    this.listeners.forEach((listener) => listener());
    const voices = this.synthesis.getVoices();
    const localVoice =
      voices.find((voice) => voice.localService && voice.lang === language) ??
      voices.find(
        (voice) => voice.localService && voice.lang.split("-")[0] === language.split("-")[0],
      );
    let index = 0;
    const next = () => {
      if (this.active !== session) return;
      const text = chunks[index++];
      if (text === undefined) {
        this.stop(owner);
        return;
      }
      const utterance = this.createUtterance(text);
      session.utterance = utterance;
      utterance.lang = language;
      if (localVoice) utterance.voice = localVoice;
      utterance.onend = next;
      utterance.onerror = () => {
        if (this.active !== session) return;
        this.stop(owner);
        onError();
      };
      try {
        this.synthesis.speak(utterance);
      } catch {
        this.stop(owner);
        onError();
      }
    };
    next();
  }
}

let browserPlayer: MessageSpeechPlayer | undefined;
export function getMessageSpeechPlayer() {
  if (typeof window === "undefined" || !window.speechSynthesis || !window.SpeechSynthesisUtterance)
    return null;
  browserPlayer ??= new MessageSpeechPlayer(
    window.speechSynthesis,
    (text) => new SpeechSynthesisUtterance(text),
  );
  return browserPlayer;
}
