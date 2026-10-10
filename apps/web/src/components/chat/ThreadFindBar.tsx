import { ChevronUpIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { TimelineEntry } from "~/session-logic";

export function ThreadFindBar({
  entries,
  onSelect,
  onClose,
}: {
  entries: ReadonlyArray<TimelineEntry>;
  onClose: () => void;
  onSelect: (entry: Extract<TimelineEntry, { kind: "message" }>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? entries.filter(
          (entry): entry is Extract<TimelineEntry, { kind: "message" }> =>
            entry.kind === "message" && entry.message.text.toLocaleLowerCase().includes(needle),
        )
      : [];
  }, [entries, query]);
  const currentIndex = matches.length ? index % matches.length : 0;
  const selected = matches[currentIndex];
  const selectedId = selected?.id;
  const selectMatch = useEffectEvent(() => {
    if (selected) onSelect(selected);
  });
  useEffect(() => {
    if (open && selectedId) selectMatch();
  }, [open, selectedId]);
  const close = () => {
    setOpen(false);
    onClose();
    previousFocus.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    const handle = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "f"
      )
        return;
      // A streamed page owns its own find shortcut.
      if (event.target instanceof Element && event.target.closest("[data-server-browser-surface]"))
        return;
      event.preventDefault();
      if (!input.current && document.activeElement instanceof HTMLElement) {
        previousFocus.current = document.activeElement;
      }
      setOpen(true);
      input.current?.select();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, []);
  if (!open) return null;
  const move = (delta: number) =>
    setIndex((current) =>
      matches.length ? (current + delta + matches.length) % matches.length : 0,
    );
  return (
    <div
      role="search"
      aria-label="Find in thread"
      className="absolute inset-x-2 top-2 z-30 flex items-center gap-2 rounded-lg border border-border bg-background p-2 shadow-md"
    >
      <Input
        ref={input}
        autoFocus
        aria-label="Find in loaded messages"
        placeholder="Find in thread"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            move(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span role="status" className="shrink-0 text-xs text-muted-foreground">
        {query
          ? matches.length
            ? `${currentIndex + 1}/${matches.length} messages`
            : "No matches"
          : "Loaded messages"}
      </span>
      <Button
        size="xs"
        variant="outline"
        aria-label="Previous match"
        disabled={!matches.length}
        onClick={() => move(-1)}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        size="xs"
        variant="outline"
        aria-label="Next match"
        disabled={!matches.length}
        onClick={() => move(1)}
      >
        <ChevronDownIcon />
      </Button>
      <Button size="xs" variant="ghost" aria-label="Close find" onClick={close}>
        <XIcon />
      </Button>
    </div>
  );
}
