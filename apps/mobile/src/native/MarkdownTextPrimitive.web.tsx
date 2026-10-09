import { Text } from "react-native";
import type { MarkdownTextPrimitiveProps } from "@t3tools/mobile-markdown-text/primitive";

export function MarkdownTextPrimitive({
  nativeTextRef,
  selectionHandleColor: _selectionHandleColor,
  uiTextView: _uiTextView,
  contextMenuConfig: _contextMenuConfig,
  contextClipboardConfig: _contextClipboardConfig,
  onContextMenuAction: _onContextMenuAction,
  onSelectionChange: _onSelectionChange,
  ...props
}: MarkdownTextPrimitiveProps) {
  return <Text {...props} ref={nativeTextRef} selectable />;
}
