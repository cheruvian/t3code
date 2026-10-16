import type { Definition, RootContent } from "mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfmToMarkdown } from "mdast-util-gfm";
import { parseMarkdownDocument } from "./markdownDocument";

export function hasMermaid(node: RootContent): boolean {
  return node.type === "code"
    ? node.lang?.trim().toLowerCase() === "mermaid"
    : "children" in node && node.children.some((child) => hasMermaid(child as RootContent));
}

/** Serialize the subtree so enclosing quote/list markers cannot become leaf content. */
export function mermaidNodeMarkdown(
  node: RootContent,
  definitions: readonly Definition[] = [],
): string {
  return toMarkdown(
    { type: "root", children: [node, ...definitions] },
    { extensions: [gfmToMarkdown()] },
  ).replace(/\n$/, "");
}

/** Replace complete root blocks so native media slots also support diagrams in lists. */
export function enrichedMermaidBlocks(markdown: string) {
  const blocks = new Map<string, RootContent>();
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  if (!/[`~]{3,}[ \t]*mermaid(?:[ \t\r\n]|$)/i.test(markdown))
    return { markdown, blocks, definitions: [] as Definition[] };
  const document = parseMarkdownDocument(markdown);
  const definitions = document.children.filter(
    (node): node is Definition => node.type === "definition",
  );
  for (const node of document.children) {
    if (!hasMermaid(node)) continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    let url = `t3-mermaid://block/${start}`;
    while (markdown.includes(url)) url += "-diagram";
    blocks.set(url, node);
    edits.push({ start, end, replacement: `![Mermaid diagram](${url})` });
  }
  let rendered = markdown;
  for (const edit of edits.reverse())
    rendered = rendered.slice(0, edit.start) + edit.replacement + rendered.slice(edit.end);
  return { markdown: rendered, blocks, definitions };
}
