import { expect, it } from "vite-plus/test";
import { enrichedFileLinks } from "./enrichedFileLinks";

it("keeps missing storage keys as code and resolves existing files without changing copied source", () => {
  const missing = "word-split-repro/1790368741038/collect-prod-source.png";
  const markdown = `\`${missing}\` and \`tree/report.md\``;
  const source = enrichedFileLinks(
    markdown,
    new Map([
      [
        "tree/report.md",
        {
          path: "tree/report.md",
          absolutePath: "/workspace/tree/report.md",
          relativePath: "report.md",
        },
      ],
    ]),
  );
  expect(source.markdown).toContain(`\`${missing}\``);
  expect([...source.links.values()]).toEqual([
    { href: "/workspace/tree/report.md", source: "`tree/report.md`" },
  ]);
});

it("retains descriptive emphasis and a filename while copying each authored occurrence", () => {
  const markdown =
    "[validates **the input**](/repo/a.ts:12) and [opens `the output`](/repo/a.ts:12)";
  const result = enrichedFileLinks(markdown);
  expect(result.markdown).toContain("[validates **the input** a.ts:12]");
  expect(result.markdown).toContain("[opens `the output` a.ts:12]");
  expect([...result.links.values()]).toEqual([
    { href: "/repo/a.ts:12", source: "[validates **the input**](/repo/a.ts:12)" },
    { href: "/repo/a.ts:12", source: "[opens `the output`](/repo/a.ts:12)" },
  ]);
});

it("preserves Windows paths and leaves prose, URLs, code examples and package names alone", () => {
  const markdown =
    "[Open](<C:\\repo\\.t3\\shot.png>)\n\n```md\n`src/example.ts`\n```\n\nUse @t3tools/contracts and https://example.com.";
  const result = enrichedFileLinks(markdown);
  expect([...result.links.values()]).toEqual([
    { href: "C:\\repo\\.t3\\shot.png", source: "[Open](<C:\\repo\\.t3\\shot.png>)" },
  ]);
  expect(result.markdown).toContain("```md\n`src/example.ts`\n```");
  expect(result.markdown).toContain("Use @t3tools/contracts and https://example.com.");
});

it("does not replace a URL authored in the document with an internal file identity", () => {
  const result = enrichedFileLinks("t3-file://link/23\n\n`src/file.ts`");
  for (const key of result.links.keys()) expect(key).not.toBe("t3-file://link/23");
});

it("renders file mentions without swallowing punctuation or changing package references and code", () => {
  const markdown =
    'Inspect @src/Checkout.tsx. Use @t3tools/contracts and @"docs/my report.md" next.\n\n`@src/code.ts`\n\n```md\n@src/example.ts\n```';
  const result = enrichedFileLinks(markdown);
  expect([...result.links.values()]).toEqual([
    { href: "src/Checkout.tsx", source: "@src/Checkout.tsx" },
    { href: "docs/my report.md", source: '@"docs/my report.md"' },
  ]);
  expect(result.markdown).toContain("Checkout.tsx](<t3-file://");
  expect(result.markdown).toContain(". Use @t3tools/contracts");
  expect(result.markdown).toContain("`@src/code.ts`");
  expect(result.markdown).toContain("```md\n@src/example.ts\n```");
});
