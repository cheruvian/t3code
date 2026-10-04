import { MermaidDiagram, MermaidViewToggle } from "@t3tools/mobile-markdown-text/mermaid";
import { useState } from "react";
import { Platform, ScrollView, Text as NativeText, View, type ColorValue } from "react-native";

import { CopyTextButton } from "../../components/CopyTextButton";
import type { ReviewDiffTheme } from "../review/shikiReviewHighlighter";
import { useMarkdownCodeHighlight } from "./markdownCodeHighlightState";

export function MarkdownCodeBlock(props: {
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly content: string;
  readonly copyTintColor: ColorValue;
  readonly headerTextColor: string;
  readonly fontSize: number;
  readonly highlightCode: boolean;
  readonly language?: string | null;
  readonly lineHeight: number;
  readonly textColor: string;
  readonly theme: ReviewDiffTheme;
}) {
  const content = props.content.replace(/\n$/, "");
  const languageLabel = props.language?.trim() || "text";
  const highlighted = useMarkdownCodeHighlight({
    code: content,
    enabled: props.highlightCode && Boolean(props.language?.trim()),
    language: props.language,
    theme: props.theme,
  });
  const isMermaid = languageLabel.toLowerCase() === "mermaid";
  const [showSource, setShowSource] = useState(false);
  let tokenOffset = 0;
  const source = (
    <ScrollView
      horizontal
      bounces={false}
      nestedScrollEnabled={Platform.OS === "android"}
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="px-3.5 py-3"
    >
      <NativeText
        selectable
        selectionColorClassName={Platform.OS === "android" ? "accent-focus/32" : undefined}
        className="font-mono"
        style={{
          color: props.textColor,
          fontSize: props.fontSize,
          lineHeight: props.lineHeight,
          ...(Platform.OS === "android" ? { includeFontPadding: false } : null),
        }}
      >
        {highlighted
          ? highlighted.map((line, lineIndex) => {
              const lineStartOffset = tokenOffset;
              const lineText = line.map((token) => token.content).join("");
              const renderedLine = (
                <NativeText key={`line:${lineStartOffset}:${lineText}`}>
                  {line.map((token) => {
                    const startOffset = tokenOffset;
                    tokenOffset += token.content.length;
                    const fontStyle =
                      token.fontStyle !== null && (token.fontStyle & 1) === 1
                        ? ("italic" as const)
                        : ("normal" as const);
                    const fontWeight =
                      token.fontStyle !== null && (token.fontStyle & 2) === 2
                        ? ("700" as const)
                        : ("400" as const);

                    return (
                      <NativeText
                        key={`${startOffset}:${token.content}:${token.color ?? ""}:${
                          token.fontStyle ?? ""
                        }`}
                        style={{
                          color: token.color ?? props.textColor,
                          fontStyle,
                          fontWeight,
                        }}
                      >
                        {token.content}
                      </NativeText>
                    );
                  })}
                  {lineIndex + 1 < highlighted.length ? "\n" : ""}
                </NativeText>
              );
              if (lineIndex + 1 < highlighted.length) {
                tokenOffset += 1;
              }
              return renderedLine;
            })
          : content}
      </NativeText>
    </ScrollView>
  );

  return (
    <View
      className="my-3 min-w-0 max-w-full self-stretch overflow-hidden rounded-lg border"
      style={{ backgroundColor: props.backgroundColor, borderColor: props.borderColor }}
    >
      <View
        className="flex-row items-center justify-between gap-2 border-b py-1 pr-1.5 pl-3.5"
        style={{ borderBottomColor: props.borderColor }}
      >
        <NativeText
          className="flex-1 font-mono uppercase opacity-70"
          numberOfLines={1}
          style={{
            color: props.headerTextColor,
            fontSize: props.fontSize,
            ...(Platform.OS === "android" ? { includeFontPadding: false } : null),
          }}
        >
          {languageLabel}
        </NativeText>
        {isMermaid ? (
          <MermaidViewToggle
            showSource={showSource}
            onPress={() => setShowSource((value) => !value)}
            color={props.headerTextColor}
          />
        ) : null}
        <CopyTextButton
          accessibilityLabel="Copy code"
          text={content}
          tintColor={props.copyTintColor}
          buttonSize={32}
          iconSize={16}
        />
      </View>
      {isMermaid && !showSource ? (
        <MermaidDiagram code={content} theme={props.theme} color={props.headerTextColor}>
          {source}
        </MermaidDiagram>
      ) : (
        source
      )}
    </View>
  );
}
