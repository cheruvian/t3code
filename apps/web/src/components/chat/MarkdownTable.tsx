import { T, useGT } from "gt-react";
import { CheckIcon, CopyIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useRef, type ComponentProps, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useClientSettings } from "../../hooks/useSettings";
import { useUiStateStore } from "../../uiStateStore";
import { observeResize } from "../../lib/observeResize";
import {
  serializeTableElementToCsv,
  serializeTableElementToHtml,
  serializeTableElementToMarkdown,
} from "../../markdown-clipboard";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure, type TableCopyFormat } from "./markdownActionFailure";

const TABLE_COPY_SERIALIZERS: Record<TableCopyFormat, (table: Element) => string> = {
  markdown: serializeTableElementToMarkdown,
  csv: serializeTableElementToCsv,
  html: serializeTableElementToHtml,
};

/**
 * Whether any cell is clipped in the unwrapped layout. Only then does the wrap
 * toggle change anything, so short tables hide it. Measures with the container
 * briefly unwrapped and restores it before the browser paints.
 */
function tableHasClippedCells(container: HTMLElement, table: HTMLTableElement): boolean {
  const viewport = table.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
  const scrollLeft = viewport?.scrollLeft ?? 0;
  const previous = container.dataset.expanded;
  container.dataset.expanded = "false";
  try {
    for (const row of table.rows) {
      for (const cell of row.cells) {
        if (cell.scrollWidth > cell.clientWidth) return true;
      }
    }
    return false;
  } finally {
    if (previous === undefined) delete container.dataset.expanded;
    else container.dataset.expanded = previous;
    // The unwrapped layout can be narrower and clamp a sideways scroll.
    if (viewport && scrollLeft > 0) viewport.scrollLeft = scrollLeft;
  }
}

export function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const gt = useGT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const tableWrap = useUiStateStore((state) => state.wrapTableCells);
  const defaultExpanded = tableWrap ?? wordWrap;
  const [wrapping, setWrapping] = useState({ defaultExpanded, expanded: defaultExpanded });
  if (wrapping.defaultExpanded !== defaultExpanded) {
    setWrapping({ defaultExpanded, expanded: defaultExpanded });
  }
  const expanded =
    wrapping.defaultExpanded === defaultExpanded ? wrapping.expanded : defaultExpanded;
  const [hasClippedCells, setHasClippedCells] = useState(false);
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard<TableCopyFormat>({
    timeout: 1200,
    onError: (cause, format) =>
      reportMarkdownActionFailure({ operation: "copy-table", format }, cause),
  });
  const expandLabel = expanded ? gt("Collapse table cells") : gt("Expand table cells");
  const copyLabel = copied ? gt("Copied") : gt("Copy table");

  // React calls this with null when a previous attach returned no cleanup.
  const attachContainer = (container: HTMLDivElement | null) => {
    containerRef.current = container;
    const table = container?.querySelector("table");
    if (!container || !table) return;
    const measure = () => setHasClippedCells(tableHasClippedCells(container, table));
    measure();
    // A streamed cell can grow until it clips while the table keeps its size, and a
    // narrower column can clip a cell without this component rendering.
    const mutations = new MutationObserver(measure);
    mutations.observe(table, { childList: true, characterData: true, subtree: true });
    const stopResize = observeResize(table, measure);
    return () => {
      mutations.disconnect();
      stopResize();
      containerRef.current = null;
    };
  };

  const handleCopy = (format: TableCopyFormat) => {
    const table = containerRef.current?.querySelector("table");
    if (!table) return;
    const text = TABLE_COPY_SERIALIZERS[format](table);
    // Plain-text targets get the markup; rich targets (mail, docs, wikis) paste a real table.
    copyToClipboard(
      text,
      format,
      format === "html" ? { "text/html": `<meta charset="utf-8">${text}` } : undefined,
      { requireHtml: format === "html" },
    );
  };

  return (
    <div
      ref={attachContainer}
      className="chat-markdown-table-container"
      data-expanded={expanded ? "true" : "false"}
    >
      <ScrollArea radius="none" chainVerticalScroll scrollFade className="w-full max-w-full">
        <table {...props}>{children}</table>
      </ScrollArea>
      {/* Stays within the row's px-1: the chat lane clips sideways overflow. */}
      <div className="mt-0.5 -mx-1 flex items-center justify-between select-none">
        {hasClippedCells ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant={expanded ? "secondary" : "ghost-muted"}
                  size="icon-xs"
                  aria-pressed={expanded}
                  onClick={() => setWrapping({ defaultExpanded, expanded: !expanded })}
                  aria-label={expandLabel}
                />
              }
            >
              {expanded ? (
                <Minimize2Icon className="size-3" />
              ) : (
                <Maximize2Icon className="size-3" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">{expandLabel}</TooltipPopup>
          </Tooltip>
        ) : (
          <span />
        )}
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label={copyLabel}
                    />
                  }
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>
              <T>Copy as Markdown</T>
            </MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>
              <T>Copy as CSV</T>
            </MenuItem>
            <MenuItem onClick={() => handleCopy("html")}>
              <T>Copy as HTML</T>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
