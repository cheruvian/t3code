import { useEffect, useRef, useState } from "react";
import { PlayIcon, Volume2Icon } from "lucide-react";
import {
  getMessageSpeechPlayer,
  speechFromSection,
  type MessageSpeechSection,
} from "~/lib/messageSpeech";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const sectionObservers = new Map<Element, () => void>();
let sectionObserver: IntersectionObserver | undefined;

function observeSpeechSection(element: Element, reveal: () => void) {
  sectionObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        sectionObservers.get(entry.target)?.();
        sectionObservers.delete(entry.target);
        sectionObserver?.unobserve(entry.target);
      }
    },
    { rootMargin: "200px 0px" },
  );
  sectionObservers.set(element, reveal);
  sectionObserver.observe(element);
  return () => {
    sectionObserver?.unobserve(element);
    sectionObservers.delete(element);
    if (sectionObservers.size === 0) {
      sectionObserver?.disconnect();
      sectionObserver = undefined;
    }
  };
}

export function MessageSpeechSections({
  owner,
  sections,
  index,
}: {
  owner: string;
  sections: ReadonlyArray<MessageSpeechSection>;
  index: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observes the speech-control surface so long replies do not eagerly mount thousands of offscreen buttons.
  useEffect(() => {
    if (visible || !container.current) return;
    return observeSpeechSection(container.current.parentElement ?? container.current, () =>
      setVisible(true),
    );
  }, [visible]);
  const player = getMessageSpeechPlayer();
  const section = sections[index];
  if (!player || !section) return null;

  const play = (text: string) =>
    player.playPlain(owner, text, document.documentElement.lang || navigator.language, () => {
      toastManager.add({ type: "error", title: "Could not read this message aloud." });
    });

  return (
    <div
      ref={container}
      className="absolute right-0 top-0 min-h-px min-w-px flex shrink-0 items-center gap-1 rounded-full bg-background/95 sm:pointer-events-none sm:opacity-0 sm:group-hover/speech-block:pointer-events-auto sm:group-hover/speech-block:opacity-100 sm:focus-within:pointer-events-auto sm:focus-within:opacity-100"
    >
      {visible ? (
        <>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            className="size-9 sm:size-6"
            aria-label={`Play from this section: ${section.label}`}
            title="Play from here"
            onClick={() => play(speechFromSection(sections, index))}
          >
            <PlayIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            className="size-9 sm:size-6"
            aria-label={`Play only this section: ${section.label}`}
            title="Play this block"
            onClick={() => play(section.text)}
          >
            <Volume2Icon className="size-3.5" />
          </Button>
        </>
      ) : null}
    </div>
  );
}
