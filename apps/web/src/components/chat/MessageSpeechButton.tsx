import { useSyncExternalStore } from "react";
import { CirclePlayIcon, SquareIcon, Volume2Icon } from "lucide-react";
import { getMessageSpeechPlayer } from "~/lib/messageSpeech";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

export function MessageSpeechButton({
  owner,
  text,
  latest = false,
}: {
  owner: string;
  text: string;
  latest?: boolean;
}) {
  const player = getMessageSpeechPlayer();
  const active = useSyncExternalStore(
    player?.subscribe ?? emptySubscribe,
    player?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  const speaking = active === owner || (latest && active !== null);
  if (!player || !text.trim()) return null;
  const label = speaking
    ? "Stop reading"
    : latest
      ? "Play entire latest reply"
      : "Read message aloud";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className={
              latest
                ? "h-9 gap-1.5 rounded-full px-3 text-muted-foreground hover:text-foreground"
                : "size-9 text-muted-foreground hover:text-foreground sm:size-6"
            }
            aria-label={label}
            aria-pressed={speaking}
            onClick={() => {
              if (speaking) player.stop();
              else
                player.play(
                  owner,
                  text,
                  document.documentElement.lang || navigator.language,
                  () => {
                    toastManager.add({
                      type: "error",
                      title: "Could not read this message aloud.",
                      description: "Try again or check your browser's speech support.",
                    });
                  },
                );
            }}
          >
            {speaking ? (
              <SquareIcon className="size-3.5" />
            ) : latest ? (
              <CirclePlayIcon className="size-4" />
            ) : (
              <Volume2Icon className="size-3.5" />
            )}
            {latest ? (
              <span className="text-xs">{speaking ? "Stop" : "Play full reply"}</span>
            ) : null}
          </Button>
        }
      />
      <TooltipPopup>
        {speaking
          ? "Stop reading"
          : latest
            ? "Play the entire latest assistant reply"
            : "Read message aloud (code blocks omitted)"}
      </TooltipPopup>
    </Tooltip>
  );
}
