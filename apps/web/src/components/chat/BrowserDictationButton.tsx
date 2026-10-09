import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { useBrowserDictation } from "./useBrowserDictation";

export function BrowserDictationButton({
  voice,
  disabled,
}: {
  voice: ReturnType<typeof useBrowserDictation>;
  disabled: boolean;
}) {
  const buttonClass =
    "flex size-11 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground hover:bg-accent disabled:opacity-40";
  return (
    <div className="flex items-center gap-1" data-composer-dictation-controls>
      {voice.busy ? (
        <button
          type="button"
          className={buttonClass}
          aria-label="Cancel dictation"
          onPointerDown={(event) => event.preventDefault()}
          onClick={voice.cancel}
        >
          <XIcon className="size-4" />
        </button>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={buttonClass}
              aria-label={voice.busy ? "Finish dictation" : "Start dictation"}
              aria-pressed={voice.busy}
              disabled={disabled || voice.phase === "finishing"}
              onPointerDown={(event) => event.preventDefault()}
              onClick={voice.busy ? voice.stop : voice.start}
            >
              {voice.busy ? (
                <CheckIcon className="size-4 text-primary" />
              ) : (
                <MicIcon className="size-4" />
              )}
            </button>
          }
        />
        <TooltipPopup>
          {voice.supported
            ? "Dictate without the keyboard. Your browser may send audio to its speech service."
            : "Dictation requires HTTPS and a browser with speech recognition, such as Safari."}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
