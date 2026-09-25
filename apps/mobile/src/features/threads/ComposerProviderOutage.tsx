import type { ServerProvider } from "@t3tools/contracts";
import { Linking, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";

const DRIVER_LABEL: Partial<Record<string, string>> = {
  codex: "Codex",
  claudeAgent: "Claude",
  cursor: "Cursor",
  grok: "Grok",
};

export function getProviderOutageBannerKey(status: ServerProvider | null): string | null {
  const advisory = status?.outageAdvisory;
  if (!advisory || advisory.severity === "none") return null;
  return [status.instanceId, advisory.severity, advisory.message ?? ""].join("\u0000");
}

/** Docked above the composer, alongside `ComposerFeedback`/`ComposerUsageLimits`. */
export function ComposerProviderOutage({
  status,
  onDismiss,
}: {
  readonly status: ServerProvider | null;
  readonly onDismiss: () => void;
}) {
  const advisory = status?.outageAdvisory;
  if (!status || !advisory || getProviderOutageBannerKey(status) === null) {
    return null;
  }

  const providerName =
    status.displayName?.trim() || DRIVER_LABEL[status.driver] || String(status.driver);
  const title =
    advisory.severity === "outage"
      ? `${providerName} is experiencing an outage`
      : `${providerName} is experiencing degraded performance`;

  return (
    <View className="px-4 pb-3">
      <View className="gap-2 rounded-[20px] border-continuous bg-card p-4">
        <View className="flex-row items-center gap-3">
          <Text className="min-w-0 flex-1 text-sm text-foreground">{title}</Text>
          <Pressable
            accessibilityLabel="Dismiss outage notice"
            accessibilityRole="button"
            hitSlop={12}
            onPress={onDismiss}
            className="p-1 active:opacity-60"
          >
            <SymbolView
              name="xmark"
              size={14}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
        </View>
        {advisory.message ? (
          <Text selectable className="text-xs text-foreground-muted">
            {advisory.message}
          </Text>
        ) : null}
        {advisory.statusPageUrl ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void Linking.openURL(advisory.statusPageUrl!)}
            className="self-start py-1 active:opacity-60"
          >
            <Text className="text-sm text-foreground">Status page</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
