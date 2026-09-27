import { PlayIcon, Volume2Icon } from "lucide-react";
import {
  getMessageSpeechPlayer,
  speechFromSection,
  type MessageSpeechSection,
} from "~/lib/messageSpeech";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";
import { MessageSpeechButton } from "./MessageSpeechButton";
import { MessageSpeechRateControl } from "./MessageSpeechRateControl";

export function MessageSpeechSections({
  owner,
  sections,
  index,
  fullReply,
}: {
  owner: string;
  sections: ReadonlyArray<MessageSpeechSection>;
  index: number;
  fullReply?: string;
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
        "flex items-center justify-end gap-1 sm:absolute sm:right-0 sm:top-0 sm:rounded-full sm:bg-background/95 sm:group-hover/speech-block:pointer-events-auto sm:group-hover/speech-block:opacity-100 sm:focus-within:pointer-events-auto sm:focus-within:opacity-100",
        fullReply ? "sm:pointer-events-auto sm:opacity-100" : "sm:pointer-events-none sm:opacity-0",
      )}
    >
      {fullReply ? (
        <div className="mr-auto flex shrink-0 items-center gap-0.5">
          <MessageSpeechRateControl />
          <MessageSpeechButton owner={owner} text={fullReply} latest />
        </div>
      ) : null}
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
