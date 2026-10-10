import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useEffect, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, XIcon } from "lucide-react";
import { quickCommandNavigation } from "@t3tools/shared/quickCommandNavigation";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { Button } from "../ui/button";
import type { ComposerCommandItem } from "./ComposerCommandMenu";

const groups = ["Saved prompts", "Commands", "Skills"] as const;
type Group = (typeof groups)[number];
function groupOf(item: ComposerCommandItem): Group | null {
  if (item.type === "saved-prompt") return "Saved prompts";
  if (item.type === "skill") return "Skills";
  if (item.type === "slash-command" || item.type === "provider-slash-command") return "Commands";
  return null;
}
function nameOf(item: ComposerCommandItem) {
  if (item.type === "saved-prompt") return item.prompt.name.toLowerCase().replace(/\s+/g, "-");
  if (item.type === "skill") return item.skill.name.toLowerCase();
  if (item.type === "slash-command") return item.command.toLowerCase();
  if (item.type === "provider-slash-command") return item.command.name.toLowerCase();
  return item.label.toLowerCase();
}

export function ComposerQuickCommandPicker(props: {
  items: readonly ComposerCommandItem[];
  canSend: boolean;
  disabled: boolean;
  onSelect: (item: ComposerCommandItem, behavior: "insert" | "send") => void;
  onDismiss: () => void;
  onTextbox: () => void;
}) {
  const available = groups.filter((group) => props.items.some((item) => groupOf(item) === group));
  const [category, setCategory] = useState<Group>(available[0] ?? "Commands");
  const group = available.includes(category) ? category : available[0];
  const [prefixes, setPrefixes] = useState<string[]>([]);
  const [choosingCategory, setChoosingCategory] = useState(false);
  const listRef = useRef<LegendListRef>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const prefix = prefixes.at(-1) ?? "";
  const { matches, branches } = quickCommandNavigation(
    props.items.filter((item) => groupOf(item) === group),
    prefix,
    nameOf,
  );
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [group, prefix]);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) props.onDismiss();
      }}
    >
      <SheetPopup side="bottom" showCloseButton={false} finalFocus={false}>
        <div className="mx-auto w-full max-w-lg px-3 pb-3">
          <div
            className="flex h-8 touch-none items-center justify-center"
            aria-hidden="true"
            onPointerDown={(event) => {
              start.current = { x: event.clientX, y: event.clientY };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              start.current = null;
            }}
            onPointerUp={(event) => {
              const point = start.current;
              start.current = null;
              if (
                point &&
                event.clientY - point.y >= 48 &&
                event.clientY - point.y > Math.abs(event.clientX - point.x)
              )
                props.onDismiss();
            }}
          >
            <div className="h-1 w-9 rounded-full bg-muted-foreground/40" />
          </div>
          <SheetTitle className="sr-only">Prompt and command picker</SheetTitle>
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <Button
                variant="ghost"
                size="lg"
                onClick={() => setChoosingCategory(!choosingCategory)}
                aria-label="Choose command category"
                aria-expanded={choosingCategory}
              >
                {group ?? "Commands"} · {matches.length}
              </Button>
            </div>
            <Button variant="ghost" size="lg" onClick={props.onTextbox}>
              Textbox
            </Button>
            <Button
              variant="ghost"
              size="icon-xl"
              aria-label="Close command picker"
              onClick={props.onDismiss}
            >
              <XIcon />
            </Button>
          </div>
          {choosingCategory && (
            <div className="flex flex-wrap gap-2 py-2">
              {available.map((value) => (
                <Button
                  key={value}
                  variant={value === group ? "secondary" : "ghost"}
                  size="lg"
                  aria-pressed={value === group}
                  onClick={() => {
                    setCategory(value);
                    setPrefixes([]);
                    setChoosingCategory(false);
                  }}
                >
                  {value}
                </Button>
              ))}
            </div>
          )}
          <LegendList
            ref={listRef}
            data={matches}
            keyExtractor={(item) => item.id}
            estimatedItemSize={64}
            drawDistance={192}
            style={{ height: Math.max(64, Math.min(matches.length, 3) * 64) }}
            className="overscroll-contain"
            ListEmptyComponent={
              <p className="py-4 text-sm text-muted-foreground">No matching commands.</p>
            }
            renderItem={({ item }) => {
              const label =
                item.type === "saved-prompt"
                  ? item.prompt.name
                  : item.type === "skill"
                    ? item.skill.name
                    : item.label;
              const applies = item.type === "slash-command";
              return (
                <div
                  key={item.id}
                  className="flex h-16 items-center gap-2 border-b border-border py-1"
                >
                  <span
                    className="min-w-0 flex-1 line-clamp-2 break-words text-sm"
                    aria-description={item.description}
                  >
                    {label}
                  </span>
                  <Button
                    size="lg"
                    variant="secondary"
                    disabled={props.disabled}
                    aria-label={`${applies ? "Apply" : "Insert"} ${label}`}
                    onClick={() => props.onSelect(item, "insert")}
                  >
                    <ArrowDownIcon />
                    {applies ? "Apply" : "Insert"}
                  </Button>
                  {!applies && (
                    <Button
                      size="lg"
                      disabled={props.disabled || !props.canSend}
                      aria-label={`Send ${label} with current draft`}
                      onClick={() => props.onSelect(item, "send")}
                    >
                      <ArrowUpIcon />
                      Send
                    </Button>
                  )}
                </div>
              );
            }}
          />
          {prefix && (
            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="ghost"
                size="icon-xl"
                aria-label="Previous letter filter"
                onClick={() => setPrefixes(prefixes.slice(0, -1))}
              >
                <ChevronLeftIcon />
              </Button>
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {prefix}
              </span>
              <Button
                variant="ghost"
                size="lg"
                aria-label="Reset letter filter"
                onClick={() => setPrefixes([])}
              >
                Reset
              </Button>
            </div>
          )}
          {branches.length > 0 && (
            <div
              key={`${group}:${prefix}`}
              className="mt-2 flex gap-2 overflow-x-auto overscroll-x-contain pb-1"
            >
              {branches.map((branch) => (
                <button
                  key={branch.letter}
                  type="button"
                  className="flex size-12 shrink-0 flex-col items-center justify-center rounded-xl bg-accent text-accent-foreground"
                  aria-label={`${branch.letter.toUpperCase()}, ${branch.count} matches`}
                  onClick={() => setPrefixes([...prefixes, branch.prefix])}
                >
                  <span>{branch.letter.toUpperCase()}</span>
                  <span className="text-xs text-muted-foreground">{branch.count}</span>
                </button>
              ))}
            </div>
          )}
          <div className="pb-safe" />
        </div>
      </SheetPopup>
    </Sheet>
  );
}
