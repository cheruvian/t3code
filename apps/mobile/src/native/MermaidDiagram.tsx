import mermaidScript from "@t3tools/mobile-mermaid";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { WebView } from "react-native-webview";

import { mermaidDocument } from "./mermaidDocument";

export function MermaidViewToggle({
  showSource,
  onPress,
  color,
}: {
  showSource: boolean;
  onPress: () => void;
  color: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={showSource ? "Show diagram" : "Show source code"}
      onPress={onPress}
      style={{ padding: 8 }}
    >
      <Text style={{ color, fontSize: 12 }}>{showSource ? "Diagram" : "Code"}</Text>
    </Pressable>
  );
}

export function MermaidDiagram(props: {
  code: string;
  theme: "light" | "dark";
  color: string;
  children: ReactNode;
}) {
  // Coalesce streaming updates instead of creating a WebView for each token.
  const [stableCode, setStableCode] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Debounce native WebView creation until streamed source settles.
  useEffect(() => {
    const timer = setTimeout(() => setStableCode(props.code), 400);
    return () => clearTimeout(timer);
  }, [props.code]);
  if (stableCode !== props.code) {
    return <Text style={{ color: props.color, padding: 14 }}>Waiting for diagram…</Text>;
  }
  return <MermaidDocumentView key={`${props.theme}:${stableCode}`} {...props} />;
}

function MermaidDocumentView({
  code,
  theme,
  color,
  children,
}: {
  code: string;
  theme: "light" | "dark";
  color: string;
  children: ReactNode;
}) {
  const [height, setHeight] = useState(200);
  const [failed, setFailed] = useState(false);
  const source = useMemo(
    () => ({ html: mermaidDocument(mermaidScript, code, theme) }),
    [code, theme],
  );
  if (failed) {
    return (
      <>
        <Text style={{ color, padding: 14 }}>
          Could not render this Mermaid diagram. Showing source code.
        </Text>
        {children}
      </>
    );
  }
  return (
    <View style={{ height }}>
      <WebView
        source={source}
        accessibilityLabel="Mermaid diagram"
        style={{ backgroundColor: "transparent" }}
        originWhitelist={["about:blank"]}
        onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
        scrollEnabled={height >= 2000}
        setSupportMultipleWindows={false}
        onError={() => setFailed(true)}
        onContentProcessDidTerminate={() => setFailed(true)}
        onMessage={(event) => {
          let message: unknown;
          try {
            message = JSON.parse(event.nativeEvent.data);
          } catch {
            setFailed(true);
            return;
          }
          if (typeof message !== "object" || message === null) return;
          if ("error" in message) setFailed(true);
          if (
            "height" in message &&
            typeof message.height === "number" &&
            Number.isFinite(message.height)
          ) {
            setHeight(Math.max(80, Math.min(2000, message.height)));
          }
        }}
      />
    </View>
  );
}
