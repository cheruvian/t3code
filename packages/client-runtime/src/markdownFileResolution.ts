import type { ProjectResolvedFilePath } from "@t3tools/contracts";
import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  formatFilePathPosition,
  inlineCodeFilePathCandidate,
  parseMarkdownFileLink,
  normalizeMarkdownLinkDestination,
  splitMarkdownLinkSearchAndHash,
} from "./markdownLinks.ts";

import { renderCodexFileCitationsAsMarkdown } from "./codexMarkdownDirectives.ts";

const parser = unified().use(remarkParse);
export type MarkdownFileResolutions = ReadonlyMap<string, ProjectResolvedFilePath>;

/** Collect paths for the visible markdown, excluding fenced code and prose. */
export function collectMarkdownFilePaths(markdown: string): string[] {
  const paths = new Set<string>();
  const tree = parser.parse(renderCodexFileCitationsAsMarkdown(markdown));
  function visit(
    node: { type: string; value?: string; url?: string; children?: readonly (typeof node)[] },
    inLink = false,
  ) {
    const href =
      node.url ??
      (node.type === "inlineCode" && !inLink
        ? inlineCodeFilePathCandidate(node.value ?? "")
        : null);
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
