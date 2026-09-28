import { useSyncExternalStore } from "react";
import { GaugeIcon } from "lucide-react";
import { getMessageSpeechPlayer, MESSAGE_SPEECH_RATES } from "~/lib/messageSpeech";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const emptySubscribe = () => () => {};
const defaultRate = () => 1;

export function MessageSpeechRateControl() {
  const player = getMessageSpeechPlayer();
  const rate = useSyncExternalStore(
    player?.subscribe ?? emptySubscribe,
    player?.getRateSnapshot ?? defaultRate,
    defaultRate,
  );
  if (!player) return null;
  const nextRate =
    MESSAGE_SPEECH_RATES[
      (MESSAGE_SPEECH_RATES.indexOf(rate as (typeof MESSAGE_SPEECH_RATES)[number]) + 1) %
        MESSAGE_SPEECH_RATES.length
    ]!;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-9 shrink-0 gap-1 whitespace-nowrap rounded-full px-2 text-xs tabular-nums"
            aria-label={`Speech speed ${rate} times. Set to ${nextRate} times`}
            onClick={() => player.setRate(nextRate)}
          >
            <GaugeIcon className="size-3.5" aria-hidden />
            {rate}×
          </Button>
        }
      />
      <TooltipPopup>
        Speech speed. Tap to switch between 1× and 2×; the next sentence uses the new speed.
      </TooltipPopup>
    </Tooltip>
  );
}
