import { PlayIcon, Volume2Icon } from "lucide-react";
import {
  getMessageSpeechPlayer,
  speechFromSection,
  type MessageSpeechSection,
} from "~/lib/messageSpeech";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";

export function MessageSpeechSections({
  owner,
  sections,
  index,
  inline = false,
}: {
  owner: string;
  sections: ReadonlyArray<MessageSpeechSection>;
  index: number;
  inline?: boolean;
}) {
  const player = getMessageSpeechPlayer();
  const section = sections[index];
  if (!player || !section) return null;

  const play = (text: string) =>
    player.playPlain(owner, text, document.documentElement.lang || navigator.language, () => {
      toastManager.add({ type: "error", title: "Could not read this message aloud." });
    });

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1",
        !inline &&
          "justify-end sm:pointer-events-none sm:absolute sm:right-0 sm:top-0 sm:rounded-full sm:bg-background/95 sm:opacity-0 sm:group-hover/speech-block:pointer-events-auto sm:group-hover/speech-block:opacity-100 sm:focus-within:pointer-events-auto sm:focus-within:opacity-100",
      )}
    >
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="size-9 text-muted-foreground sm:size-6"
        aria-label={`Play from this section: ${section.label}`}
        title="Play from here"
        onClick={() => play(speechFromSection(sections, index))}
      >
        <PlayIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="size-9 text-muted-foreground sm:size-6"
        aria-label={`Play only this section: ${section.label}`}
        title="Play this block"
        onClick={() => play(section.text)}
      >
        <Volume2Icon className="size-3.5" />
      </Button>
    </div>
  );
}
