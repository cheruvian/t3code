import { useMemo, useState } from "react";
import { ListIcon } from "lucide-react";
import {
  getMessageSpeechPlayer,
  messageSpeechSections,
  speechFromSection,
} from "~/lib/messageSpeech";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";

export function MessageSpeechSections({ owner, text }: { owner: string; text: string }) {
  const [open, setOpen] = useState(false);
  const sections = useMemo(() => (open ? messageSpeechSections(text) : []), [open, text]);
  const player = getMessageSpeechPlayer();
  if (!player || !text.trim()) return null;

  const play = (sectionText: string) => {
    setOpen(false);
    player.playPlain(
      owner,
      sectionText,
      document.documentElement.lang || navigator.language,
      () => {
        toastManager.add({ type: "error", title: "Could not read this message aloud." });
      },
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="size-9 text-muted-foreground hover:text-foreground sm:size-6"
            aria-label="Choose a section to read"
          >
            <ListIcon className="size-3.5" />
          </Button>
        }
      />
      <PopoverPopup side="top" align="start" className="w-80 max-w-[calc(100vw-1.5rem)]">
        <div className="max-h-[min(60vh,28rem)] space-y-2 overflow-y-auto text-sm">
          <div className="font-medium">Read a section</div>
          {sections.map((section, index) => (
            <div key={index} className="border-t border-border/60 pt-2">
              <p className="line-clamp-2 text-muted-foreground">{section.label}</p>
              <div className="mt-1 flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Play section ${index + 1}: ${section.label}`}
                  onClick={() => play(section.text)}
                >
                  Play this
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Play from section ${index + 1}: ${section.label}`}
                  onClick={() => play(speechFromSection(sections, index))}
                >
                  From here
                </Button>
              </div>
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
