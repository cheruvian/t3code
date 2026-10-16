import type { Root, RootContent } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { extractMarkdownLinkHrefs, isWindowsDrivePathHref } from "@t3tools/shared/markdownLinks";

const parser = unified().use(remarkParse).use(remarkGfm);
const ENCODED_TEXT_ENTITY = /(?<!\\)&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i;
export type MarkdownNode = Root | RootContent;

function decodeCodePoint(codePoint: number, entity: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) {
        return decodeCodePoint(Number.parseInt(decimal, 10), entity);
      }
      if (hexadecimal) {
        return decodeCodePoint(Number.parseInt(hexadecimal, 16), entity);
      }
      switch (entity.toLowerCase()) {
        case "&amp;":
          return "&";
        case "&apos;":
          return "'";
        case "&gt;":
          return ">";
        case "&lt;":
          return "<";
        case "&nbsp;":
          return "\u00a0";
        case "&quot;":
          return '"';
        default:
          return entity;
      }
    },
  );
}

const HTML_TAG = /<!--[\s\S]*?-->|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi;

function attribute(tag: string, name: string): string | null {
  const attributes = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(attributes)) {
    if (match[1]?.toLowerCase() === name) {
      return decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
  }
  return null;
}

/** Called only for parsed HTML nodes, so Markdown code examples keep their literal tags. */
export function markdownHtmlContent(content: string): string {
  // An HTML block such as <details> can also contain Markdown fences and code spans.
  const codeRanges: Array<{ start: number; end: number }> = [];
  const tags = [...content.matchAll(HTML_TAG)];
  let tagIndex = 0;
  const delimiters = [...content.matchAll(/`+|~{3,}/g)].filter((delimiter) => {
    while (tags[tagIndex] && tags[tagIndex]!.index + tags[tagIndex]![0].length <= delimiter.index)
      tagIndex += 1;
    const tag = tags[tagIndex];
    return !tag || delimiter.index < tag.index;
  });
  for (let index = 0; index < delimiters.length; index += 1) {
    const opening = delimiters[index]!;
    const lineStart = content.lastIndexOf("\n", opening.index - 1) + 1;
    const fenced =
      opening[0].length >= 3 && /^ {0,3}$/.test(content.slice(lineStart, opening.index));
    if (opening[0][0] === "~" && !fenced) continue;
    let closingIndex = -1;
    for (let candidate = index + 1; candidate < delimiters.length; candidate += 1) {
      const closing = delimiters[candidate]!;
      if (!fenced && closing[0] === opening[0]) {
        closingIndex = candidate;
        break;
      }
      if (!fenced || closing[0][0] !== opening[0][0] || closing[0].length < opening[0].length)
        continue;
      const start = content.lastIndexOf("\n", closing.index - 1) + 1;
      const nextLine = content.indexOf("\n", closing.index);
      const end = nextLine === -1 ? content.length : nextLine;
      if (
        /^ {0,3}$/.test(content.slice(start, closing.index)) &&
        /^\s*$/.test(content.slice(closing.index + closing[0].length, end))
      ) {
        closingIndex = candidate;
        break;
      }
    }
    if (closingIndex === -1) {
      if (fenced) codeRanges.push({ start: opening.index, end: content.length });
      continue;
    }
    const closing = delimiters[closingIndex]!;
    codeRanges.push({ start: opening.index, end: closing.index + closing[0].length });
    index = closingIndex;
  }
  return content.replace(HTML_TAG, (tag, offset: number) => {
    if (codeRanges.some((range) => offset >= range.start && offset < range.end)) return tag;
    if (tag.startsWith("<!--")) return "";
    if (/^<img\b/i.test(tag)) {
      const src = attribute(tag, "src");
      if (!src) return "";
      const alt = (attribute(tag, "alt") ?? "").replace(/[\\[\]&]/g, "\\$&");
      const href = src
        .replace(/&/g, "\\&")
        .replace(/</g, "%3C")
        .replace(/>/g, "%3E")
        .replace(/\n/g, "");
      return `![${alt}](<${href}>)`;
    }
    if (/^<summary\b/i.test(tag)) return "\n\n**";
    if (/^<\/summary\s*>/i.test(tag)) return "**\n\n";
    if (/^<\/?(?:strong|b)\b/i.test(tag)) return "**";
    if (/^<\/?(?:em|i)\b/i.test(tag)) return "*";
    if (/^<\/?(?:del|s|strike)\b/i.test(tag)) return "~~";
    if (/^<code\b/i.test(tag)) return "`` ";
    if (/^<\/code\s*>/i.test(tag)) return " ``";
    if (/^<br\b/i.test(tag)) return "  \n";
    if (/^<\/?(?:p|div|details)\b/i.test(tag)) return "\n\n";
    return "";
  });
}

/** Convert parsed HTML fragments only, preserving Markdown code and source around them. */
export function markdownWithHtml(markdown: string): string {
  if (!/<(?:!--|\/?[a-z])/i.test(markdown) && !ENCODED_TEXT_ENTITY.test(markdown)) return markdown;
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "html") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        edits.push({ start, end, content: markdownWithHtml(markdownHtmlContent(node.value)) });
    } else if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (
        start !== undefined &&
        end !== undefined &&
        ENCODED_TEXT_ENTITY.test(markdown.slice(start, end))
      ) {
        // MD4C's native AST drops entity callbacks. Emit decoded literal text without
        // allowing decoded angle brackets or Markdown punctuation to become syntax.
        edits.push({
          start,
          end,
          content: decodeHtmlEntities(node.value).replace(/[\\`*_[\]{}()<>#+.!|~&-]/g, "\\$&"),
        });
      }
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(parser.parse(markdown));
  for (const edit of edits.reverse())
    markdown = markdown.slice(0, edit.start) + edit.content + markdown.slice(edit.end);
  return markdown;
}

export function parseMarkdownDocument(markdown: string): Root {
  return parser.parse(markdownWithHtml(markdown));
}

/** Escape authored host paths before MD4C consumes backslashes as Markdown punctuation. */
export function markdownWithAuthoredImagePaths(markdown: string): string {
  if (!markdown.includes("\\")) return markdown;
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "image" || node.type === "definition") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const source = markdown.slice(start, end);
      const prefix =
        node.type === "definition" ? source.match(/^\[[\s\S]*?\]:\s*/)?.[0] : undefined;
      const destinationSource = prefix ? `[image](${source.slice(prefix.length)})` : source;
      const href = extractMarkdownLinkHrefs(destinationSource)[0];
      if (!href || (!isWindowsDrivePathHref(href) && !href.startsWith("\\\\"))) return;
      const offset = source.indexOf(href, prefix?.length ?? source.indexOf("]") + 1);
      if (offset < 0) return;
      edits.push({
        start: start + offset,
        end: start + offset + href.length,
        content: href.replaceAll("\\", "\\\\"),
      });
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(parser.parse(markdown));
  for (const edit of edits.reverse())
    markdown = markdown.slice(0, edit.start) + edit.content + markdown.slice(edit.end);
  return markdown;
}
