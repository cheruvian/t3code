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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The speech-recognition callback reads the last committed composer identity and draft.
  useLayoutEffect(() => {
    latest.current = input;
  });
  const session = useRef<BrowserDictation | null>(null);
  const afterCommit = useRef<(() => void) | null>(null);

  const cancel = () => {
    afterCommit.current = null;
    session.current?.cancel();
    session.current = null;
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the recognition session and visibility listener; each dependency change invalidates the captured draft through cleanup.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) {
        afterCommit.current = null;
        session.current?.cancel();
        session.current = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      afterCommit.current = null;
      session.current?.cancel();
      session.current = null;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A changed owner, prompt, or permission cancels recognition of the captured draft.
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
    stopAndSubmit: (submit: () => void) => {
      if (!session.current || afterCommit.current || phase === "finishing") return;
      afterCommit.current = submit;
      session.current.stop();
    },
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
        error: (message) => {
          afterCommit.current = null;
          setError(message);
        },
        commit: (text) => {
          if (
            latest.current.owner !== captured.owner ||
            !latest.current.enabled ||
            latest.current.prompt !== captured.prompt ||
            !latest.current.commit(captured.prompt, text)
          ) {
            afterCommit.current = null;
            setError("The draft changed. Dictation was not inserted.");
          } else {
            const submit = afterCommit.current;
            afterCommit.current = null;
            submit?.();
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
