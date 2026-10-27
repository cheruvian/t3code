import { describe, expect, it } from "vite-plus/test";
import { parseMarkdown } from "react-native-enriched-markdown/src/web/parseMarkdown";
import { recognizeTextLinks } from "react-native-enriched-markdown/src/web/recognizeTextLinks";
import type { ASTNode } from "react-native-enriched-markdown/src/web/types";
import { markdownForNativeParsing } from "./markdownDocument";
import { enrichedSkillLinkRegex } from "./enrichedLinkPresentation";
import { enrichedFileLinks } from "./enrichedFileLinks";

function descendants(node: ASTNode): ASTNode[] {
  return [node, ...(node.children ?? []).flatMap(descendants)];
}
const text = (node: ASTNode): string => node.content ?? node.children?.map(text).join("") ?? "";
const parse = (markdown: string, hardSoftBreaks = false) =>
  parseMarkdown(markdownForNativeParsing(markdown), {
    latexMath: false,
    hardSoftBreaks,
  });

describe("native Markdown source contracts in the MD4C replacement", () => {
  it("keeps headings, paragraphs and tight ordered lists in one document", async () => {
    const ast = await parse("# Heading\n\nParagraph **bold** and `code`.\n\n1. First\n2. Second");
    expect(ast.type).toBe("Document");
    expect(ast.children?.map((node) => node.type)).toEqual(["Heading", "Paragraph", "OrderedList"]);
    expect(descendants(ast).find((node) => node.type === "Strong")?.children).toMatchObject([
      { content: "bold" },
    ]);
    expect(descendants(ast).find((node) => node.type === "Code")?.children).toMatchObject([
      { content: "code" },
    ]);
    expect(descendants(ast).filter((node) => node.type === "ListItem")).toHaveLength(2);
  });
  it("retains wrapped blockquotes and nested fenced code as structural containers", async () => {
    const ast = await parse(
      "> Long quote\n> wraps here\n>\n> 1. Context\n>\n>    ```js\n>    const x = 1;\n>    ```",
    );
    expect(ast.children?.[0]?.type).toBe("Blockquote");
    expect(descendants(ast).find((node) => node.type === "OrderedList")).toBeDefined();
    expect(text(descendants(ast).find((node) => node.type === "CodeBlock")!)).toBe(
      "const x = 1;\n",
    );
  });
  it("keeps hard breaks and makes authored-user soft breaks explicit", async () => {
    const markdown = "First  \nSecond\nThird";
    expect(
      descendants(await parse(markdown)).filter((node) => node.type === "LineBreak"),
    ).toHaveLength(1);
    expect(
      descendants(await parse(markdown)).filter((node) => node.type === "SoftBreak"),
    ).toHaveLength(1);
    expect(
      descendants(await parse(markdown, true)).filter((node) => node.type === "LineBreak"),
    ).toHaveLength(2);
  });
  it("normalizes inline HTML and entities without changing fenced code", async () => {
    const ast = await parse(
      "<strong>Bold</strong> &amp; <em>italic</em>\n\n```html\n<strong>literal</strong>\n```",
    );
    expect(descendants(ast).find((node) => node.type === "Strong")?.children).toMatchObject([
      { content: "Bold" },
    ]);
    expect(text(descendants(ast).find((node) => node.type === "CodeBlock")!)).toBe(
      "<strong>literal</strong>\n",
    );
    expect(text(ast)).toContain("&");
  });
  it("decodes encoded text safely while preserving escaped entities and code examples", async () => {
    expect(text(await parse("&amp;lt;script&amp;gt; &copy; &#128512;"))).toBe("<script> © 😀");
    expect(text(await parse("\\&lt;"))).toBe("&lt;");
    expect(text(await parse("`&amp;lt;`"))).toBe("&amp;lt;");
  });
  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "recognizes known %s skill tokens in quotes and leaves unknown tokens and code alone",
    async (sigil) => {
      const markdown = `> Use ${sigil}1-check and ${sigil}unknown.\n\n\`${sigil}1-check\`\n\n\`\`\`text\n${sigil}1-check\n\`\`\``;
      const ast = recognizeTextLinks(
        await parse(markdown),
        enrichedSkillLinkRegex([{ name: "1-check" }]) ?? undefined,
        undefined,
      );
      const links = descendants(ast).filter((node) => node.type === "Link");
      expect(links.map((node) => node.attributes?.url)).toEqual([`${sigil}1-check`]);
      expect(text(ast)).toContain(`${sigil}unknown`);
    },
  );
  it("preserves thread destinations and adjacent repeated context identities", async () => {
    const href = "t3-context://v1/image/screenshot";
    const ast = await parse(`[Thread](t3://thread/abc) [Checkout](${href})[Checkout](${href})`);
    expect(
      descendants(ast)
        .filter((node) => node.type === "Link")
        .map((node) => node.attributes?.url),
    ).toEqual(["t3://thread/abc", href, href]);
  });
  it("preserves authored Windows image destinations without confusing code examples", async () => {
    const ast = await parse(
      [
        String.raw`![shot](C:\Users\me\.t3\_build\shot.png "Shot")`,
        "![ref][ref]",
        String.raw`[ref]: \\wsl.localhost\Ubuntu\.t3\ref.png`,
        "`![example](C:\\Users\\me\\.t3\\shot.png)`",
        String.raw`![real](C:\Users\me.t3\shot.png)`,
      ].join("\n\n"),
    );
    expect(
      descendants(ast)
        .filter((node) => node.type === "Image")
        .map((node) => node.attributes?.url),
    ).toEqual([
      String.raw`C:\Users\me\.t3\_build\shot.png`,
      String.raw`\\wsl.localhost\Ubuntu\.t3\ref.png`,
      String.raw`C:\Users\me.t3\shot.png`,
    ]);
  });
  it("preserves descriptive emphasis and code labels through file transformation", async () => {
    const rendered = enrichedFileLinks("[see **the input** and `the output`](/repo/a.ts:12)");
    const ast = await parse(rendered.markdown);
    const link = descendants(ast).find((node) => node.type === "Link")!;
    expect(text(link)).toBe("see the input and the output a.ts · L12");
    expect(descendants(link).some((node) => node.type === "Strong")).toBe(true);
    expect(descendants(link).some((node) => node.type === "Code")).toBe(true);
  });
});
