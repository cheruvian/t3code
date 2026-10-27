import type { MarkdownFileResolutions } from "@t3tools/client-runtime/markdown-file-resolution";
import {
  markdownFileMentionRanges,
  resolvedMarkdownFileHref,
} from "@t3tools/client-runtime/markdown-file-resolution";
import {
  extractMarkdownLinkHrefs,
  isWindowsDrivePathHref,
  inlineCodeFilePathCandidate,
  isMarkdownFileLinkLabel,
} from "@t3tools/shared/markdownLinks";
import type { RootContent } from "mdast";
import { parseMarkdownDocument } from "./markdownDocument";
import { resolveMarkdownLinkPresentation } from "./markdownLinks";

export interface EnrichedFileLink {
  readonly href: string;
  readonly source: string;
}

function textContent(node: {
  type: string;
  value?: string;
  children?: readonly (typeof node)[];
}): string {
  return node.value ?? node.children?.map(textContent).join("") ?? "";
}

/** Give each file occurrence an identity so selection copy retains its own authored label. */
export function enrichedFileLinks(markdown: string, resolutions?: MarkdownFileResolutions) {
  if (!markdown.includes("`") && !markdown.includes("[") && !markdown.includes("@"))
    return { markdown, links: new Map<string, EnrichedFileLink>() };
  const document = parseMarkdownDocument(markdown, true);
  const definitions = new Map(
    document.children.flatMap((node) =>
      node.type === "definition" ? [[node.identifier.toLowerCase(), node.url] as const] : [],
    ),
  );
  const links = new Map<string, EnrichedFileLink>();
  const edits: Array<{ start: number; end: number; text: string }> = [];
  function visit(node: RootContent, inLink = false) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "text" && !inLink && start !== undefined && end !== undefined) {
      for (const mention of markdownFileMentionRanges(markdown.slice(start, end))) {
        const presentation = resolveMarkdownLinkPresentation(mention.href);
        const href = resolutions
          ? resolvedMarkdownFileHref(mention.href, resolutions)
          : mention.href;
        if (presentation.kind !== "file" || !href) continue;
        let url = `t3-file://link/${start + mention.start}`;
        while (markdown.includes(url)) url += "-file";
        links.set(url, { href, source: mention.source });
        edits.push({
          start: start + mention.start,
          end: start + mention.end,
          text: `[${presentation.label.replace(/[\\[\]]/g, "\\$&")}](<${url}>)`,
        });
      }
    }
    if (
      start !== undefined &&
      end !== undefined &&
      (node.type === "link" ||
        node.type === "linkReference" ||
        (node.type === "inlineCode" && !inLink))
    ) {
      const source = markdown.slice(start, end);
      let href =
        node.type === "link"
          ? node.url
          : node.type === "linkReference"
            ? definitions.get(node.identifier.toLowerCase())
            : inlineCodeFilePathCandidate(node.value);
      if (node.type === "link" && isWindowsDrivePathHref(node.url)) {
        href = extractMarkdownLinkHrefs(source).find(isWindowsDrivePathHref) ?? href;
      }
      const presentation = href ? resolveMarkdownLinkPresentation(href) : null;
      if (href && presentation?.kind === "file") {
        const target = resolutions ? resolvedMarkdownFileHref(href, resolutions) : href;
        if (target) {
          let url = `t3-file://link/${start}`;
          while (markdown.includes(url)) url += "-file";
          const isLink = node.type === "link" || node.type === "linkReference";
          const label = isLink ? textContent(node) : node.value;
          const descriptive = isLink && !isMarkdownFileLinkLabel(label, href);
          const first = isLink ? node.children[0]?.position?.start.offset : undefined;
          const last = isLink ? node.children.at(-1)?.position?.end.offset : undefined;
          const authoredLabel =
            first !== undefined && last !== undefined ? markdown.slice(first, last) : label;
          links.set(url, {
            href: target,
            source: node.type === "linkReference" ? `[${authoredLabel}](<${href}>)` : source,
          });
          const filename = presentation.label.replace(/[\\[\]]/g, "\\$&");
          edits.push({
            start,
            end,
            text: `[${descriptive ? `${authoredLabel} ` : ""}${filename}](<${url}>)`,
          });
          return;
        }
      }
    }
    if ("children" in node)
      for (const child of node.children)
        visit(
          child as RootContent,
          inLink || node.type === "link" || node.type === "linkReference",
        );
  }
  for (const node of document.children) visit(node);
  let rendered = markdown;
  for (const edit of edits.reverse())
    rendered = rendered.slice(0, edit.start) + edit.text + rendered.slice(edit.end);
  return { markdown: rendered, links };
}
