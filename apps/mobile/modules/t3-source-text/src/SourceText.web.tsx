import { Text } from "react-native";
import type { SourceTextProps } from "./SourceText";

export type { SourceTextProps } from "./SourceText";

/** Browser text uses the platform's selection without loading native view bindings. */
export function SourceText({
  nativeTextRef,
  onSelectionChange: _onSelectionChange,
  ...props
}: SourceTextProps) {
  return <Text ref={nativeTextRef} {...props} />;
}
