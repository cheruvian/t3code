import { describe, expect, it } from "vite-plus/test";
import { collectMarkdownFilePaths, resolvedMarkdownFileHref } from "./markdownFileResolution.ts";
import { parseMarkdownFileLink } from "./markdownLinks.ts";

describe("render-time file resolution", () => {
  it("collects file references without sending message prose or fenced code", () => {
    const message =
      "Storage key `word-split-repro/1790368741038/collect-prod-source.png`. [Source](src/main.ts:12) ![image](images/a.png)\n\n```\n`hidden/path.ts`\n```\n\n[web](https://example.com/a.png) [ref][r]\n\n[r]: docs/report.md";
    expect(collectMarkdownFilePaths(message)).toEqual([
      "docs/report.md",
      "images/a.png",
      "src/main.ts",
      "word-split-repro/1790368741038/collect-prod-source.png",
    ]);
    expect(collectMarkdownFilePaths("[`fake/path.ts`](https://example.com)")).toEqual([]);
  });
  it("collects rendered provider file citations", () => {
    expect(
      collectMarkdownFilePaths(':codex-file-citation{path="tree/report.md" line_range_start="7"}'),
    ).toEqual(["tree/report.md"]);
  });
  const resolutions = new Map([
    [
      "tree/file.ts",
      { path: "tree/file.ts", absolutePath: "/workspace/tree/file.ts", relativePath: "file.ts" },
    ],
    [
      "image.svg",
      { path: "image.svg", absolutePath: "/workspace/a%#?.svg", relativePath: "a%#?.svg" },
    ],
  ]);
  it("preserves line positions and media fragments, decoding filenames once", () => {
    expect(resolvedMarkdownFileHref("tree/file.ts#L12C3", resolutions)).toBe(
      "/workspace/tree/file.ts:12:3",
    );
    const href = resolvedMarkdownFileHref("image.svg#logo", resolutions)!;
    expect(href).toBe("/workspace/a%25%23%3F.svg#logo");
    expect(parseMarkdownFileLink(href)?.path).toBe("/workspace/a%#?.svg");
  });
  it("does not guess a destination for missing or unresolved paths", () => {
    expect(resolvedMarkdownFileHref("missing/file.png", resolutions)).toBeNull();
  });
});
