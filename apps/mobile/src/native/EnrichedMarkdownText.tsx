import { resolvedMarkdownFileHref } from "@t3tools/client-runtime/markdown-file-resolution";
import { decodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextHref,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import { markdownWithAuthoredImagePaths, markdownWithHtml } from "../lib/markdownDocument";
import type { Definition, RootContent } from "mdast";
import { enrichedMermaidBlocks, hasMermaid, mermaidNodeMarkdown } from "../lib/enrichedMermaid";
import { enrichedFileLinks } from "../lib/enrichedFileLinks";
import { MarkdownCodeBlock } from "../features/threads/MarkdownCodeBlock";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Platform, Share, StyleSheet, Text, View } from "react-native";
import {
  EnrichedMarkdownText,
  type DocumentAssetsEvent,
  type MarkdownStyle,
  type MarkdownMediaAsset,
} from "react-native-enriched-markdown";
import type { SelectableMarkdownTextProps } from "./SelectableMarkdownText.types";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { Menu } from "../components/ui/Menu";
import { useEnrichedLinkVariants } from "./useEnrichedLinkVariants";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import {
  enrichedSkillReference,
  enrichedSkillLinkRegex,
  enrichedLinkVariantPattern,
} from "../lib/enrichedLinkPresentation";

function enrichedStyle(
  style: SelectableMarkdownTextProps["textStyle"],
  dark: boolean,
): MarkdownStyle {
  const monospace = Platform.OS === "ios" ? "Menlo" : "monospace";
  // Keep the radius modest: iOS clips square table-cell borders without stroking the corner arcs.
  const block = {
    marginTop: 4,
    marginBottom: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: style.dividerColor,
  };
  const body = {
    color: style.color,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    marginTop: 0,
    marginBottom: 8,
  };
  const heading = (level: number) => {
    const fontSize = style.headingFontSizes?.[level - 1] ?? style.fontSize * (1.6 - level * 0.1);
    return {
      ...body,
      color: style.strongColor,
      fontFamily: style.headingFontFamily,
      fontSize,
      lineHeight: fontSize * 1.35,
      marginTop: 8,
    };
  };
  return {
    paragraph: body,
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    strong: { color: style.strongColor, fontFamily: style.boldFontFamily, fontWeight: "normal" },
    link: { color: style.linkColor, underline: false },
    code: {
      fontFamily: monospace,
      color: style.inlineCodeColor,
      backgroundColor: "transparent",
      borderColor: "transparent",
      fontSize: style.fontSize * 0.9,
    },
    codeBlock: {
      ...body,
      color: style.codeColor,
      backgroundColor: style.codeBlockBackgroundColor,
      fontFamily: monospace,
      fontSize: style.fontSize * 0.9,
      ...block,
      padding: 12,
      syntaxColors: dark
        ? {
            keyword: "#ff7b72",
            string: "#a5d6ff",
            number: "#79c0ff",
            constant: "#79c0ff",
            comment: "#8b949e",
            function: "#d2a8ff",
            type: "#ffa657",
            property: "#79c0ff",
            tag: "#7ee787",
            attribute: "#79c0ff",
          }
        : {
            keyword: "#cf222e",
            string: "#0a3069",
            number: "#0550ae",
            constant: "#0550ae",
            comment: "#6e7781",
            function: "#8250df",
            type: "#953800",
            property: "#0550ae",
            tag: "#116329",
            attribute: "#0550ae",
          },
    },
    blockquote: {
      ...body,
      color: style.mutedColor,
      backgroundColor: "transparent",
      borderColor: style.quoteMarkerColor,
      borderWidth: 2,
      gapWidth: 12,
    },
    list: { ...body, bulletColor: style.mutedColor, markerColor: style.mutedColor, gapWidth: 6 },
    thematicBreak: { color: style.dividerColor, height: 1, marginTop: 8, marginBottom: 8 },
    table: {
      ...body,
      ...block,
      headerFontFamily: style.boldFontFamily,
      headerTextColor: style.strongColor,
      headerBackgroundColor: style.codeBlockBackgroundColor,
      rowEvenBackgroundColor: "transparent",
      rowOddBackgroundColor: "transparent",
      cellPaddingHorizontal: 10,
      cellPaddingVertical: 7,
    },
    taskList: {
      checkedColor: style.linkColor,
      checkedTextColor: style.color,
      borderColor: style.mutedColor,
      checkedStrikethrough: false,
    },
  };
}

export function MobileEnrichedMarkdownText(props: SelectableMarkdownTextProps) {
  return <EnrichedMarkdownDocument {...props} authoredImagePaths />;
}

function EnrichedMarkdownDocument(
  props: SelectableMarkdownTextProps & { readonly authoredImagePaths?: boolean },
) {
  const { renderImage, resolveImageSource } = props;
  const markdown = useMemo(() => {
    const content = markdownWithHtml(props.markdown);
    return props.authoredImagePaths ? markdownWithAuthoredImagePaths(content) : content;
  }, [props.markdown, props.authoredImagePaths]);
  const mermaid = useMemo(
    () =>
      Platform.OS === "web"
        ? { markdown, blocks: new Map<string, RootContent>(), definitions: [] as Definition[] }
        : enrichedMermaidBlocks(markdown),
    [markdown],
  );
  const files = useMemo(
    () => enrichedFileLinks(mermaid.markdown, props.fileResolutions),
    [mermaid, props.fileResolutions],
  );
  const resolveLink = useCallback(
    (url: string) =>
      files.links.get(url)?.href ??
      (props.fileResolutions ? (resolvedMarkdownFileHref(url, props.fileResolutions) ?? url) : url),
    [files, props.fileResolutions],
  );
  const { themeAppearance } = useAppearancePreferences();
  const [documentAssets, setDocumentAssets] = useState<DocumentAssetsEvent["assets"]>([]);
  const onDocumentAssets = useCallback(({ assets }: DocumentAssetsEvent) => {
    setDocumentAssets((previous) =>
      previous.length === assets.length &&
      previous.every((asset, index) => {
        const next = assets[index]!;
        return (
          asset.id === next.id &&
          asset.kind === next.kind &&
          asset.url === next.url &&
          asset.altText === next.altText &&
          asset.title === next.title &&
          asset.placement === next.placement &&
          asset.eligible === next.eligible
        );
      })
        ? previous
        : assets,
    );
  }, []);
  const { linkVariants, linkPillContent } = useEnrichedLinkVariants(
    documentAssets,
    props,
    files.links,
  );
  const linkRecognition = useMemo(
    () => ({
      text: enrichedSkillLinkRegex(props.skills) ?? undefined,
    }),
    [props.skills],
  );
  const [activeMenu, setActiveMenu] = useState<{
    url: string;
    menu: NonNullable<ReturnType<NonNullable<typeof props.fileContextMenu>>>;
  } | null>(null);
  const { fileContextMenu, onLinkPress, onFileContextMenuAction } = props;
  const performMenuAction = useCallback(
    (url: string, actionId: string) => {
      if (actionId === "enriched-open-link") onLinkPress?.(resolveLink(url));
      else if (actionId === "enriched-copy-link") copyTextWithHaptic(resolveLink(url));
      else if (actionId === "enriched-share-link") void Share.share({ message: resolveLink(url) });
      else onFileContextMenuAction?.(resolveLink(url), actionId);
    },
    [onLinkPress, onFileContextMenuAction, resolveLink],
  );
  const linkContextMenuItems = useMemo(
    () =>
      Platform.OS === "ios" && (fileContextMenu || onLinkPress)
        ? Object.fromEntries(
            [
              ...new Set(
                documentAssets.filter((asset) => asset.kind === "link").map((asset) => asset.url),
              ),
            ].map((url) => {
              const menu = fileContextMenu?.(resolveLink(url)) ?? {
                title: url,
                actions: [
                  { id: "enriched-open-link", title: "Open link" },
                  { id: "enriched-copy-link", title: "Copy link" },
                  { id: "enriched-share-link", title: "Share link" },
                ],
              };
              return [
                enrichedLinkVariantPattern(url),
                menu.actions.map((action) => ({
                  text: action.title,
                  disabled: "disabled" in action && action.disabled,
                  onPress: () => performMenuAction(url, action.id),
                })),
              ];
            }),
          )
        : undefined,
    [documentAssets, fileContextMenu, onLinkPress, performMenuAction, resolveLink],
  );
  const selectionClipboard = useMemo(() => {
    const fragment = decodeComposerContextFragment(props.contextClipboardFragment);
    const references = collectComposerContextReferences(props.markdown);
    const linkTextByUrl = Object.fromEntries(
      references.flatMap((reference) => {
        const record = fragment?.records.find((entry) => entry.contextId === reference.contextId);
        return record
          ? [
              [
                formatComposerContextHref(reference.kind, reference.contextId),
                formatComposerContextReference({ ...reference, label: record.label }),
              ],
            ]
          : [];
      }),
    );
    for (const [url, link] of files.links) linkTextByUrl[url] = link.source;
    for (const asset of documentAssets) {
      if (asset.kind === "link" && enrichedSkillReference(asset.url, props.skills))
        linkTextByUrl[asset.url] = asset.url;
    }
    if (!fragment && Object.keys(linkTextByUrl).length === 0) return undefined;
    return {
      linkTextByUrl,
      ...(fragment
        ? {
            htmlAttributes: {
              "data-t3-context-fragment": encodeURIComponent(props.contextClipboardFragment!),
            },
            mimeTypes: { "app.t3.context-fragment": props.contextClipboardFragment! },
          }
        : {}),
    };
  }, [props.contextClipboardFragment, props.markdown, props.skills, files, documentAssets]);
  const markdownStyle = useMemo(
    () => ({ ...enrichedStyle(props.textStyle, themeAppearance === "dark"), linkVariants }),
    [props.textStyle, themeAppearance, linkVariants],
  );
  const renderMedia = useCallback(
    (asset: MarkdownMediaAsset) => {
      const node = mermaid.blocks.get(asset.url);
      if (node)
        return (
          <MermaidMarkdownBlock
            node={node}
            definitions={mermaid.definitions}
            markdownProps={props}
          />
        );
      return (
        renderImage?.({
          href: asset.url,
          alt: asset.altText || null,
          title: asset.title || null,
        }) ?? null
      );
    },
    [renderImage, mermaid, markdown, props],
  );
  const resolveNativeImageSource = useCallback(
    (asset: MarkdownMediaAsset) =>
      resolveImageSource?.({
        href: asset.url,
        alt: asset.altText || null,
        title: asset.title || null,
      }) ?? null,
    [resolveImageSource],
  );
  const renderMarkdown = (openAndroidMenu?: () => void) => {
    const onLinkLongPress =
      Platform.OS === "android" && props.fileContextMenu
        ? ({ url }: { url: string }) => {
            const menu = props.fileContextMenu?.(resolveLink(url)) ?? {
              title: url,
              actions: [
                { id: "enriched-open-link", title: "Open link" },
                { id: "enriched-copy-link", title: "Copy link" },
              ],
            };
            setActiveMenu({ url, menu });
            openAndroidMenu?.();
          }
        : undefined;

    return (
      <View
        style={{
          flexShrink: 1,
          minWidth: 0,
          marginTop: props.marginTop,
          marginBottom: props.marginBottom,
        }}
      >
        <EnrichedMarkdownText
          markdown={files.markdown}
          markdownStyle={markdownStyle}
          onDocumentAssets={onDocumentAssets}
          renderMedia={renderImage || mermaid.blocks.size > 0 ? renderMedia : undefined}
          resolveImageSource={resolveImageSource ? resolveNativeImageSource : undefined}
          onImagePress={
            props.onImagePress || props.onLinkPress
              ? ({ url }) => (props.onImagePress ?? props.onLinkPress)?.(url)
              : undefined
          }
          linkRecognition={linkRecognition}
          containerStyle={{ flexShrink: 1, minWidth: 0 }}
          flavor="github"
          selectable
          selectionClipboard={selectionClipboard}
          selectionColor={props.textStyle.selectionColor}
          selectionHandleColor={props.textStyle.selectionHandleColor}
          md4cFlags={{
            latexMath: false,
            hardSoftBreaks: props.preserveSoftBreaks ?? false,
            admonitions: true,
          }}
          enableTaskListItemToggle={false}
          enableCodeBlockWrapToggle
          spoilerOverlay="solid"
          onLinkPress={
            props.onLinkPress ? ({ url }) => props.onLinkPress?.(resolveLink(url)) : undefined
          }
          onLinkLongPress={onLinkLongPress}
          linkContextMenuItems={linkContextMenuItems}
          linkPillContent={linkPillContent}
        />
      </View>
    );
  };

  return Platform.OS === "android" && props.fileContextMenu ? (
    <Menu
      shouldOpenOnLongPress
      title={activeMenu?.menu.title}
      actions={
        activeMenu?.menu.actions.map((action) => ({
          id: action.id,
          title: action.title,
          attributes: { disabled: action.disabled },
        })) ?? []
      }
      onPressAction={({ nativeEvent }) => {
        if (activeMenu) performMenuAction(activeMenu.url, nativeEvent.event);
      }}
      style={{ flexShrink: 1, minWidth: 0 }}
    >
      <MarkdownMenuAnchor renderMarkdown={renderMarkdown} />
    </Menu>
  ) : (
    renderMarkdown()
  );
}

function MermaidMarkdownBlock({
  node,
  definitions,
  markdownProps,
}: {
  node: RootContent;
  definitions: readonly Definition[];
  markdownProps: SelectableMarkdownTextProps;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const style = markdownProps.textStyle;
  if (node.type === "code" && node.lang?.trim().toLowerCase() === "mermaid") {
    return (
      <MarkdownCodeBlock
        content={node.value}
        language="mermaid"
        backgroundColor={style.codeBlockBackgroundColor}
        borderColor={style.dividerColor}
        copyTintColor={style.mutedColor}
        headerTextColor={style.mutedColor}
        textColor={style.codeColor}
        fontSize={style.fontSize * 0.9}
        lineHeight={style.lineHeight}
        highlightCode={false}
        theme={themeAppearance === "dark" ? "dark" : "light"}
      />
    );
  }
  if (!hasMermaid(node))
    return (
      <EnrichedMarkdownDocument
        {...markdownProps}
        authoredImagePaths={false}
        markdown={mermaidNodeMarkdown(node, definitions)}
      />
    );
  if (node.type === "list")
    return (
      <View style={{ minWidth: 0 }}>
        {node.children.map((item, index) => (
          <View key={index} style={{ flexDirection: "row", minWidth: 0 }}>
            <Text
              style={{
                color: style.color,
                fontSize: style.fontSize,
                lineHeight: style.lineHeight,
                minWidth: 24,
              }}
            >
              {node.ordered ? `${(node.start ?? 1) + index}.` : "•"}
            </Text>
            <View style={{ flex: 1, minWidth: 0 }}>
              {item.checked == null ? null : (
                <Text style={{ color: style.color }}>{item.checked ? "☑" : "☐"}</Text>
              )}
              {item.children.map((child, childIndex) => (
                <MermaidMarkdownBlock
                  key={childIndex}
                  node={child}
                  definitions={definitions}
                  markdownProps={markdownProps}
                />
              ))}
            </View>
          </View>
        ))}
      </View>
    );
  if (node.type === "blockquote")
    return (
      <View
        style={{ borderLeftColor: style.quoteMarkerColor, borderLeftWidth: 2, paddingLeft: 12 }}
      >
        {node.children.map((child, index) => (
          <MermaidMarkdownBlock
            key={index}
            node={child}
            definitions={definitions}
            markdownProps={markdownProps}
          />
        ))}
      </View>
    );
  return "children" in node ? (
    <View>
      {node.children.map((child, index) => (
        <MermaidMarkdownBlock
          key={index}
          node={child as RootContent}
          definitions={definitions}
          markdownProps={markdownProps}
        />
      ))}
    </View>
  ) : null;
}

/** Adapts the rich-text link gesture to Menu's long-press trigger without wrapping text in a Pressable. */
function MarkdownMenuAnchor(props: {
  readonly renderMarkdown: (openMenu?: () => void) => ReactNode;
  readonly onLongPress?: () => void;
}) {
  return props.renderMarkdown(props.onLongPress);
}
