import { resolvedMarkdownFileHref } from "@t3tools/client-runtime/markdown-file-resolution";
import { useMemo } from "react";
import { Image } from "react-native";
import type {
  LinkPillContent,
  MarkdownDocumentAsset,
  MarkdownStyle,
} from "react-native-enriched-markdown";
import { markdownFileIconSource } from "../lib/markdownFileIcons";
import { markdownLinkIconSource } from "../lib/markdownLinkIcons";
import { resolveMarkdownLinkIcon, resolveMarkdownLinkPresentation } from "../lib/markdownLinks";
import type { SelectableMarkdownTextProps } from "./SelectableMarkdownText.types";
import type { EnrichedFileLink } from "../lib/enrichedFileLinks";
import {
  enrichedContextLinkPresentation,
  enrichedLinkVariantPattern,
  enrichedSkillDisplayName,
  enrichedSkillReference,
} from "../lib/enrichedLinkPresentation";

function presentation(
  url: string,
  props: Pick<
    SelectableMarkdownTextProps,
    "linkCustomization" | "skills" | "textStyle" | "fileResolutions"
  >,
  fileLinks?: ReadonlyMap<string, EnrichedFileLink>,
) {
  const file = fileLinks?.get(url);
  const custom = props.linkCustomization?.(file?.href ?? url);
  if (custom) return custom;
  const context = enrichedContextLinkPresentation(url);
  if (context) return { color: context.color, icon: markdownFileIconSource(context.icon) };
  const skill = enrichedSkillReference(url, props.skills);
  if (skill)
    return {
      color: props.textStyle.skillTextColor,
      label: enrichedSkillDisplayName(skill),
      icon: markdownFileIconSource("mcp"),
    };
  const link = resolveMarkdownLinkPresentation(file?.href ?? url);
  if (link.kind === "file") {
    if (!file && props.fileResolutions && !resolvedMarkdownFileHref(url, props.fileResolutions))
      return undefined;
    return {
      color: props.textStyle.fileTextColor,
      label: file ? undefined : link.label,
      icon: markdownFileIconSource(link.icon),
    };
  }
  const icon = link.kind === "external" ? resolveMarkdownLinkIcon(link.host) : null;
  return icon
    ? {
        color: props.textStyle.linkColor,
        icon: markdownLinkIconSource(icon),
        iconTintColor: props.textStyle.linkColor,
      }
    : undefined;
}

export function useEnrichedLinkVariants(
  assets: ReadonlyArray<MarkdownDocumentAsset>,
  props: SelectableMarkdownTextProps,
  fileLinks?: ReadonlyMap<string, EnrichedFileLink>,
) {
  const { linkCustomization, skills, textStyle, fileResolutions } = props;
  const links = useMemo(() => {
    const byUrl = new Map<string, NonNullable<ReturnType<typeof presentation>>>();
    for (const asset of assets) {
      if (asset.kind !== "link" || byUrl.has(asset.url)) continue;
      const value = presentation(
        asset.url,
        { linkCustomization, skills, textStyle, fileResolutions },
        fileLinks,
      );
      if (value) byUrl.set(asset.url, value);
    }
    return byUrl;
  }, [assets, linkCustomization, skills, textStyle, fileResolutions, fileLinks]);
  const linkVariants = useMemo<MarkdownStyle["linkVariants"]>(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => {
          const color = link.color ?? textStyle.fileTextColor;
          return [
            enrichedLinkVariantPattern(url),
            {
              pill: {
                borderColor: "transparent",
                borderWidth: 0,
                borderRadius: 6,
                paddingHorizontal: 5,
                paddingVertical: 2,
              },
              fontFamily: textStyle.fontFamily,
              color,
              underline: false,
              backgroundColor: "transparent",
            },
          ];
        }),
      ),
    [links, textStyle],
  );
  const linkPillContent = useMemo<Record<string, LinkPillContent>>(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => [
          url,
          {
            label: link.label,
            iconUri: link.icon ? Image.resolveAssetSource(link.icon)?.uri : undefined,
            iconTintColor: link.iconTintColor,
          },
        ]),
      ),
    [links],
  );
  return { linkVariants, linkPillContent };
}
