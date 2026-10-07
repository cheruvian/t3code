import { useAtomValue } from "@effect/atom-react";
import {
  CONNECTION_TIMING_FIELDS,
  DEFAULT_CONNECTION_TIMING,
  type ConnectionTimingSettings as TimingSettings,
} from "@t3tools/client-runtime/connection";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

export function ConnectionTimingSettings() {
  const settings = useAtomValue(environmentCatalog.timingValueAtom);
  const update = useAtomCommand(environmentCatalog.setTiming, { reportFailure: false });
  const [expanded, setExpanded] = useState<keyof TimingSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (next: TimingSettings) => {
    setSaving(true);
    try {
      const result = await update(next);
      if (result._tag === "Failure")
        Alert.alert("Could not save connection timeouts", "Try again before leaving this screen.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <View className="mt-5 gap-3">
      <SettingsSection title="Connection timeouts">
        <Text className="p-4 text-sm text-foreground-muted">
          Saved on this device for all environments. Longer timeouts tolerate slow networks but take
          longer to detect a lost connection. Changes apply to the next attempt or health check.
        </Text>
        {CONNECTION_TIMING_FIELDS.map((field) => (
          <View key={field.key}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={field.label}
              accessibilityState={{ expanded: expanded === field.key }}
              className="gap-1 p-4"
              onPress={() => setExpanded(expanded === field.key ? null : field.key)}
            >
              <Text className="text-base text-foreground">
                {field.label}:{" "}
                {settings[field.key] === 0 ? "Automatic" : `${settings[field.key]} seconds`}
              </Text>
              <Text className="text-sm text-foreground-muted">{field.description}</Text>
            </Pressable>
            {expanded === field.key
              ? field.options.map((value) => (
                  <Pressable
                    key={value}
                    accessibilityRole="radio"
                    accessibilityState={{
                      checked: settings[field.key] === value,
                      disabled: saving,
                    }}
                    disabled={saving}
                    className="px-6 py-3"
                    onPress={() => void save({ ...settings, [field.key]: value })}
                  >
                    <Text
                      className={
                        settings[field.key] === value
                          ? "text-base text-primary-text"
                          : "text-base text-foreground"
                      }
                    >
                      {value === 0 ? "Automatic" : `${value} seconds`}
                      {settings[field.key] === value ? " ✓" : ""}
                    </Text>
                  </Pressable>
                ))
              : null}
          </View>
        ))}
        <View className="p-4">
          <MaterialButton
            label="Reset defaults"
            disabled={saving}
            onPress={() => void save(DEFAULT_CONNECTION_TIMING)}
          />
        </View>
      </SettingsSection>
    </View>
  );
}
