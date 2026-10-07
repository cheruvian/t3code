import { useAtomValue } from "@effect/atom-react";
import { getProviderOutageIncidents } from "@t3tools/client-runtime/provider-outage";
import { Alert, Pressable } from "react-native";

import { environmentServerConfigsAtom } from "../state/server";
import { SymbolView } from "./AppSymbol";

export function ProviderOutageIcon() {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const incidents = getProviderOutageIncidents(
    [...configs.values()].flatMap((config) => config.providers),
  );
  if (!incidents.length) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${incidents.length} active provider service incidents`}
      hitSlop={8}
      className="p-1 active:opacity-60"
      onPress={() =>
        Alert.alert(
          "Provider service incidents",
          incidents
            .map(
              (incident) =>
                `${incident.providerName}: ${incident.name}${incident.message ? `\n${incident.message}` : ""}`,
            )
            .join("\n\n"),
        )
      }
    >
      <SymbolView
        name="exclamationmark.triangle"
        size={16}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
    </Pressable>
  );
}
