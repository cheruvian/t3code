import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";
import { MobileEnrichedMarkdownText } from "./EnrichedMarkdownText";
import { parseMarkdown } from "react-native-enriched-markdown/src/web/parseMarkdown";
import type { ASTNode } from "react-native-enriched-markdown/src/web/types";

const harness = vi.hoisted(() => ({ platform: "ios", copy: vi.fn() }));
vi.mock("react-native", () => ({
  get Platform() {
    return { OS: harness.platform };
  },
  View: "View",
  Text: "Text",
  ScrollView: "ScrollView",
  Pressable: "Pressable",
  StyleSheet: { hairlineWidth: 1 },
  ActionSheetIOS: {},
  Share: {},
}));
vi.mock("react-native-webview", () => ({ WebView: "WebView" }));
vi.mock("@t3tools/mobile-mermaid", () => ({ default: "/* Mermaid runtime supplied by Metro */" }));
vi.mock("./useEnrichedLinkVariants", () => ({ useEnrichedLinkVariants: () => ({}) }));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));
vi.mock("../components/AndroidAnchoredMenu", () => ({
  AndroidAnchoredMenu: "AndroidAnchoredMenu",
}));
vi.mock("../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: harness.copy }));
vi.mock("../features/threads/markdownCodeHighlightState", () => ({
  useMarkdownCodeHighlight: () => null,
}));
vi.mock("../components/CopyTextButton", async () => {
  const { createElement } = await import("react");
  return {
    CopyTextButton: ({ text }: { text: string }) =>
      createElement("CopyButton", { onPress: () => harness.copy(text) }),
  };
});
vi.mock("react-native-enriched-markdown", async () => {
  const { createElement } = await import("react");
  return {
    // The native parser exposes eligible block images through this public media callback.
    EnrichedMarkdownText: ({
      markdown,
      renderMedia,
      ...rest
    }: {
      markdown: string;
      renderMedia?: (asset: { url: string }) => ReactNode;
    }) =>
      createElement(
        "EnrichedMarkdownText",
        { markdown, renderMedia, ...rest },
        ...[...markdown.matchAll(/!\[[^\]]*\]\((t3-mermaid:[^)]+)\)/g)].map((match) =>
          renderMedia?.({ url: match[1]! }),
        ),
      ),
  };
});

const style: NativeMarkdownTextStyle = {
  color: "#eee",
  strongColor: "#fff",
  mutedColor: "#aaa",
  linkColor: "#00f",
  inlineCodeColor: "#eee",
  codeColor: "#eee",
  codeBackgroundColor: "#111",
  codeBlockBackgroundColor: "#111",
  fileTextColor: "#eee",
  skillTextColor: "#eee",
  quoteMarkerColor: "#aaa",
  dividerColor: "#333",
  fontSize: 14,
  lineHeight: 20,
  fontFamily: "body",
  headingFontFamily: "heading",
  boldFontFamily: "bold",
};
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("delivers authored Windows images through the parser beside nested diagrams", async () => {
  harness.platform = "ios";
  const href = String.raw`C:\Users\me\.t3\shot.png`;
  await act(async () => {
    renderer = create(
      <MobileEnrichedMarkdownText
        markdown={`![Top](<${href}>)\n\n> ![Nested](<${href}>)\n>\n> \`\`\`mermaid\n> graph TD; A-->B\n> \`\`\``}
        textStyle={style}
      />,
    );
  });
  const descendants = (node: ASTNode): ASTNode[] => [
    node,
    ...(node.children ?? []).flatMap(descendants),
  ];
  const urls: unknown[] = [];
  for (const native of renderer!.root.findAll(
    (node) => node.type === ("EnrichedMarkdownText" as ReactTestInstance["type"]),
  )) {
    const ast = await parseMarkdown(native.props.markdown, { latexMath: false });
    urls.push(
      ...descendants(ast)
        .filter((node) => node.type === "Image" && !node.attributes?.url?.startsWith("t3-mermaid:"))
        .map((node) => node.attributes?.url),
    );
  }
  expect(urls).toEqual([href, href]);
});

it.each(["ios", "android"])(
  "renders diagrams through Enriched media on %s, switches to source and copies authored code",
  async (platform) => {
    harness.platform = platform;
    const code = "graph TD; A-->B";
    await act(async () => {
      renderer = create(
        <MobileEnrichedMarkdownText
          markdown={`Before\n\n\`\`\`mermaid\n${code}\n\`\`\`\n\nAfter`}
          textStyle={style}
        />,
      );
    });
    expect(
      renderer!.root.findAll((node) => node.type === ("WebView" as ReactTestInstance["type"])),
    ).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    const webview = renderer!.root.find(
      (node) => node.type === ("WebView" as ReactTestInstance["type"]),
    );
    expect(webview.props.source.html).toContain(code);
    expect(webview.props.onShouldStartLoadWithRequest({ url: "https://example.com" })).toBe(false);
    const toggle = () => renderer!.root.findByProps({ accessibilityLabel: "Show source code" });
    await act(async () => toggle().props.onPress());
    expect(
      renderer!.root.findAll((node) => node.type === ("WebView" as ReactTestInstance["type"])),
    ).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain(code);
    await act(async () =>
      renderer!.root
        .find((node) => node.type === ("CopyButton" as ReactTestInstance["type"]))
        .props.onPress(),
    );
    expect(harness.copy).toHaveBeenCalledWith(code);
    await act(async () =>
      renderer!.root.findByProps({ accessibilityLabel: "Show diagram" }).props.onPress(),
    );
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await act(async () =>
      renderer!.root
        .find((node) => node.type === ("WebView" as ReactTestInstance["type"]))
        .props.onMessage({ nativeEvent: { data: '{"error":true}' } }),
    );
    expect(JSON.stringify(renderer!.toJSON())).toContain("Showing source code");
    expect(JSON.stringify(renderer!.toJSON())).toContain(code);
  },
);

it("keeps nested diagrams reachable and coalesces streaming updates before mounting the WebView", async () => {
  harness.platform = "ios";
  const markdown = "1. Context\n\n   > ```mermaid\n   > graph TD; A-->B\n   > ```\n\n2. Finish";
  await act(async () => {
    renderer = create(<MobileEnrichedMarkdownText markdown={markdown} textStyle={style} />);
  });
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
  await act(async () =>
    renderer!.update(
      <MobileEnrichedMarkdownText
        markdown={markdown.replace("A-->B", "A-->C")}
        textStyle={style}
      />,
    ),
  );
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
  expect(
    renderer!.root.findAll((node) => node.type === ("WebView" as ReactTestInstance["type"])),
  ).toHaveLength(0);
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
  const webview = renderer!.root.find(
    (node) => node.type === ("WebView" as ReactTestInstance["type"]),
  );
  expect(webview.props.source.html).toContain("A-->C");
  expect(webview.props.source.html).not.toContain("A-->B");
});

it("routes file presses to the owning host and retains per-occurrence source for selection copy", async () => {
  const onLinkPress = vi.fn();
  const markdown =
    "[reads **the input**](tree/report.md) and [checks `the output`](tree/report.md) plus `missing/storage.png`";
  const fileResolutions = new Map([
    [
      "tree/report.md",
      {
        path: "tree/report.md",
        absolutePath: "/host/tree/report.md",
        relativePath: "tree/report.md",
      },
    ],
  ]);
  await act(async () => {
    renderer = create(
      <MobileEnrichedMarkdownText
        markdown={markdown}
        textStyle={style}
        fileResolutions={fileResolutions}
        onLinkPress={onLinkPress}
      />,
    );
  });
  const native = renderer!.root.find(
    (node) => node.type === ("EnrichedMarkdownText" as ReactTestInstance["type"]),
  );
  const urls = [...native.props.markdown.matchAll(/t3-file:\/\/link\/[^>]+/g)].map(
    (match) => match[0],
  );
  expect(urls).toHaveLength(2);
  expect(native.props.markdown).toContain("reads **the input** report.md");
  expect(native.props.markdown).toContain("`missing/storage.png`");
  expect(native.props.linkRecognition.inlineCode).toBeUndefined();
  await act(async () => {
    native.props.onLinkPress({ url: urls[1] });
  });
  expect(onLinkPress).toHaveBeenCalledWith("/host/tree/report.md");
  await act(async () =>
    native.props.onDocumentAssets({
      assets: [
        {
          id: "file-1",
          kind: "link",
          url: urls[0],
          altText: "",
          title: "",
          placement: "inline",
          eligible: true,
        },
      ],
    }),
  );
  const updated = renderer!.root.find(
    (node) => node.type === ("EnrichedMarkdownText" as ReactTestInstance["type"]),
  );
  const menu = Object.values(updated.props.linkContextMenuItems)[0] as Array<{
    text: string;
    onPress: () => void;
  }>;
  await act(async () => menu.find((item) => item.text === "Copy link")!.onPress());
  expect(harness.copy).toHaveBeenCalledWith("/host/tree/report.md");
  expect(native.props.selectionClipboard.linkTextByUrl).toEqual({
    [urls[0]!]: "[reads **the input**](tree/report.md)",
    [urls[1]!]: "[checks `the output`](tree/report.md)",
  });
});
