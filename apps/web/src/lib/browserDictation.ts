// SpeechRecognition is not yet included in TypeScript's DOM declarations.
export interface BrowserRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult:
    | ((event: {
        results: ArrayLike<{ isFinal: boolean; [index: number]: { transcript: string } }>;
      }) => void)
    | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export function getBrowserRecognition() {
  if (typeof window === "undefined" || !window.isSecureContext) return null;
  const browser = window as Window & {
    SpeechRecognition?: new () => BrowserRecognition;
    webkitSpeechRecognition?: new () => BrowserRecognition;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition ?? null;
}

export type DictationPhase = "idle" | "starting" | "listening" | "finishing";

/** Owns one recognition session; cancelled sessions can never commit late results. */
export class BrowserDictation {
  private recognition: BrowserRecognition | null = null;
  private timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly callbacks: {
      phase: (phase: DictationPhase) => void;
      preview: (text: string) => void;
      commit: (text: string) => void;
      error: (message: string) => void;
    },
  ) {}

  start(recognition: BrowserRecognition, language: string) {
    this.cancel();
    this.recognition = recognition;
    let transcript = "";
    const current = () => this.recognition === recognition;
    recognition.lang = language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => {
      if (current()) this.callbacks.phase("listening");
    };
    recognition.onresult = (event) => {
      if (!current()) return;
      const results = Array.from(event.results);
      transcript = results
        .filter((result) => result.isFinal)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      this.callbacks.preview(
        results
          .map((result) => result[0]?.transcript ?? "")
          .join(" ")
          .trim(),
      );
    };
    recognition.onerror = ({ error }) => {
      if (!current()) return;
      this.cancel();
      this.callbacks.error(
        error === "not-allowed" || error === "service-not-allowed"
          ? "Microphone or speech access was denied. Allow it in your browser settings and try again."
          : error === "no-speech"
            ? "No speech was detected. Try again."
            : "Dictation is unavailable. Check your connection and browser speech settings, then try again.",
      );
    };
    recognition.onend = () => {
      if (!current()) return;
      this.release();
      if (transcript) this.callbacks.commit(transcript);
      else this.callbacks.error("No speech was detected. Try again.");
    };
    this.callbacks.phase("starting");
    try {
      this.timeout = setTimeout(() => this.stop(), 5 * 60 * 1000);
      recognition.start();
    } catch {
      this.cancel();
      this.callbacks.error(
        "Could not start dictation. Try again in Safari or another supported browser.",
      );
    }
  }

  stop() {
    if (!this.recognition) return;
    clearTimeout(this.timeout);
    this.callbacks.phase("finishing");
    try {
      const recognition = this.recognition;
      // A browser service that never sends onend must not leave Send blocked.
      this.timeout = setTimeout(() => {
        this.cancel();
        this.callbacks.error("Dictation did not finish. Please try again.");
      }, 10_000);
      recognition.stop();
    } catch {
      this.cancel();
      this.callbacks.error("Could not finish dictation. Please try again.");
    }
  }

  cancel() {
    const recognition = this.recognition;
    this.release();
    try {
      recognition?.abort();
    } catch {
      /* Already stopped by the browser. */
    }
  }

  private release() {
    clearTimeout(this.timeout);
    this.recognition = null;
    this.callbacks.phase("idle");
    this.callbacks.preview("");
  }
}
