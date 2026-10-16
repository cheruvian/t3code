import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { formatFilePathPosition } from "@t3tools/shared/fileLinks";
import type { ProjectResolvedFilePath } from "@t3tools/contracts";
import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  extractMarkdownLinkHrefs,
  isWindowsDrivePathHref,
  inlineCodeFilePathCandidate,
  parseMarkdownFileLink,
  normalizeMarkdownLinkDestination,
  splitMarkdownLinkSearchAndHash,
} from "@t3tools/shared/markdownLinks";

import { renderCodexInlineDirectivesAsMarkdown } from "@t3tools/shared/codexMarkdownDirectives";

const parser = unified().use(remarkParse);
export type MarkdownFileResolutions = ReadonlyMap<string, ProjectResolvedFilePath>;

/** File mentions retain authored copy text and leave scoped package references alone. */
export function markdownFileMentionRanges(text: string) {
  return collectComposerInlineTokens(`${text} `).flatMap((token) => {
    if (token.type !== "mention" || !token.source.startsWith("@")) return [];
    const href = token.source.startsWith('@"') ? token.value : token.value.replace(/[.,;!?]+$/, "");
    if (!parseMarkdownFileLink(href)) return [];
    const end = token.end - (token.value.length - href.length);
    return [{ start: token.start, end, href, source: text.slice(token.start, end) }];
  });
}

/** Collect paths for the visible markdown, excluding fenced code and ordinary prose. */
export function collectMarkdownFilePaths(markdown: string): string[] {
  const paths = new Set<string>();
  const rendered = renderCodexInlineDirectivesAsMarkdown(markdown);
  const tree = parser.parse(rendered);
  function visit(
    node: {
      type: string;
      value?: string;
      url?: string;
      position?:
        | { start: { offset?: number | undefined }; end: { offset?: number | undefined } }
        | undefined;
      children?: readonly (typeof node)[];
    },
    inLink = false,
  ) {
    if (node.type === "text" && !inLink) {
      for (const mention of markdownFileMentionRanges(node.value ?? "")) {
        const target = parseMarkdownFileLink(mention.href);
        if (target && target.path.length <= 4096 && !/^~[\\/]/.test(target.path))
          paths.add(target.path);
      }
    }
    let href =
      node.url ??
      (node.type === "inlineCode" && !inLink
        ? inlineCodeFilePathCandidate(node.value ?? "")
        : null);
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (href && isWindowsDrivePathHref(href) && start !== undefined && end !== undefined) {
      href =
        extractMarkdownLinkHrefs(rendered.slice(start, end)).find(isWindowsDrivePathHref) ?? href;
    }
    const target = href ? parseMarkdownFileLink(href) : null;
    if (
      target &&
      target.path.length <= 4096 &&
      !target.path.startsWith("~/") &&
      !target.path.startsWith("~\\")
    )
      paths.add(target.path);
    for (const child of node.children ?? []) visit(child, inLink || node.type === "link");
  }
  visit(tree);
  return [...paths].sort();
}

/** Encoding here prevents literal #, %, and ? in host filenames becoming URL syntax. */
export function resolvedMarkdownFileHref(
  href: string,
  resolutions: MarkdownFileResolutions,
): string | null {
  const target = parseMarkdownFileLink(href);
  if (!target) return null;
  const resolved = resolutions.get(target.path);
  if (!resolved?.absolutePath) return null;
  const destination = formatFilePathPosition({
    ...target,
    path: encodeURI(resolved.absolutePath).replaceAll("#", "%23").replaceAll("?", "%3F"),
  });
  const hash = splitMarkdownLinkSearchAndHash(normalizeMarkdownLinkDestination(href)).hash;
  return target.line ? destination : destination + hash;
}
