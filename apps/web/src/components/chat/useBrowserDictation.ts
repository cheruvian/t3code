import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getMessageSpeechPlayer } from "~/lib/messageSpeech";
import {
  BrowserDictation,
  getBrowserRecognition,
  type DictationPhase,
} from "~/lib/browserDictation";

export function useBrowserDictation(input: {
  owner: string;
  prompt: string;
  enabled: boolean;
  commit: (capturedPrompt: string, transcript: string) => boolean;
}) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [preview, setPreview] = useState("");
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  const session = useRef<BrowserDictation | null>(null);

  const cancel = () => {
    session.current?.cancel();
    session.current = null;
  };

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) {
        session.current?.cancel();
        session.current = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      session.current?.cancel();
      session.current = null;
    };
  }, [input.owner, input.prompt, input.enabled]);

  return {
    phase,
    preview,
    error,
    cancel,
    busy: phase !== "idle",
    supported: getBrowserRecognition() !== null,
    dismissError: () => setError(null),
    stop: () => session.current?.stop(),
    start: () => {
      const Recognition = getBrowserRecognition();
      if (!input.enabled) return;
      if (!Recognition) {
        setError(
          "Dictation requires HTTPS and a browser with speech recognition. Try Safari with Siri enabled.",
        );
        return;
      }
      cancel();
      setError(null);
      getMessageSpeechPlayer()?.stop();
      const captured = input;
      const controller = new BrowserDictation({
        phase: setPhase,
        preview: setPreview,
        error: setError,
        commit: (text) => {
          if (
            latest.current.owner !== captured.owner ||
            !latest.current.enabled ||
            latest.current.prompt !== captured.prompt ||
            !latest.current.commit(captured.prompt, text)
          ) {
            setError("The draft changed. Dictation was not inserted.");
          }
        },
      });
      session.current = controller;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      try {
        controller.start(new Recognition(), navigator.language);
      } catch {
        cancel();
        setError("Could not start browser dictation.");
      }
    },
  };
}
