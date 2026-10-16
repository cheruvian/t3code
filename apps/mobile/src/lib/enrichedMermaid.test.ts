import { describe, expect, it } from "vite-plus/test";
import { enrichedMermaidBlocks, mermaidNodeMarkdown } from "./enrichedMermaid";

describe("native Enriched Mermaid slots", () => {
  it("keeps ordinary code and literal fenced examples native", () => {
    const markdown = "```js\nconst mermaid = true;\n```\n\n````md\n```mermaid\ngraph TD\n```\n````";
    expect(enrichedMermaidBlocks(markdown)).toEqual({
      markdown,
      blocks: new Map(),
      definitions: [],
    });
  });

  it.each([
    "```mermaid\ngraph TD; A-->B\n```",
    "~~~MERMAID\ngraph TD; A-->B\n~~~",
    "```mermaid\ngraph TD; A-->",
  ])("routes authored and streaming diagrams through a native media slot: %s", (code) => {
    const result = enrichedMermaidBlocks(`Before\n\n${code}\n\nAfter`);
    expect(result.blocks.size).toBe(1);
    const [url, node] = [...result.blocks][0]!;
    expect(result.markdown).toContain(`![Mermaid diagram](${url})`);
    expect(node.type).toBe("code");
    expect(result.markdown).toMatch(/^Before/);
  });

  it("keeps nested list and quote structure around diagrams", () => {
    const markdown =
      "1. Install\n\n   > Context\n   >\n   > ```mermaid\n   > graph TD; A-->B\n   > ```\n\n2. Finish\n\nTail";
    const result = enrichedMermaidBlocks(markdown);
    const node = [...result.blocks.values()][0]!;
    expect(node.type).toBe("list");
    expect(result.blocks.size).toBe(1);
    expect(result.markdown).toContain("Tail");
    if (node.type !== "list") throw new Error("Expected list");
    expect(mermaidNodeMarkdown(node.children[0]!.children[0]!)).toBe("Install");
    expect(node.children[1]?.children[0]).toMatchObject({ type: "paragraph" });
  });

  it("does not capture an authored URL as an internal diagram", () => {
    const result = enrichedMermaidBlocks(
      "```mermaid\ngraph TD\n```\n\n![authored](t3-mermaid://block/0)",
    );
    expect(result.blocks.has("t3-mermaid://block/0")).toBe(false);
    expect(result.markdown).toContain("![authored](t3-mermaid://block/0)");
  });
});

it("serializes multiline quote leaves and fenced examples without retaining container markers", () => {
  const markdown = "> First **line**\n> second `line`\n>\n> ```mermaid\n> graph TD; A-->B\n> ```";
  const block = [...enrichedMermaidBlocks(markdown).blocks.values()][0]!;
  if (block.type !== "blockquote") throw new Error("Expected quote");
  expect(mermaidNodeMarkdown(block.children[0]!)).toBe("First **line**\nsecond `line`");
});

it("carries reference definitions into normal leaves beside a nested diagram", () => {
  const markdown =
    "> See [source][file]\n>\n> ```mermaid\n> graph TD; A-->B\n> ```\n\n[file]: src/app.ts";
  const plan = enrichedMermaidBlocks(markdown);
  const block = [...plan.blocks.values()][0]!;
  if (block.type !== "blockquote") throw new Error("Expected quote");
  expect(mermaidNodeMarkdown(block.children[0]!, plan.definitions)).toContain("[file]: src/app.ts");
});
