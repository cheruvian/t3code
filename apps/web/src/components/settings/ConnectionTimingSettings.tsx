import { useAtomValue } from "@effect/atom-react";
import {
  CONNECTION_TIMING_FIELDS,
  DEFAULT_CONNECTION_TIMING,
  type ConnectionTimingSettings as TimingSettings,
} from "@t3tools/client-runtime/connection";
import { useState } from "react";
import { environmentCatalog } from "~/connection/catalog";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function ConnectionTimingSettings() {
  const settings = useAtomValue(environmentCatalog.timingValueAtom);
  const update = useAtomCommand(environmentCatalog.setTiming, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const save = async (next: TimingSettings) => {
    setSaving(true);
    try {
      const result = await update(next);
      if (result._tag === "Failure")
        toastManager.add({ type: "error", title: "Could not save connection timeouts" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsSection
      {...searchableSetting("connection-timing")}
      title="Connection timeouts"
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={saving}
          onClick={() => void save(DEFAULT_CONNECTION_TIMING)}
        >
          Reset defaults
        </Button>
      }
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Saved on this device for all environments. Longer timeouts tolerate slow networks but take
        longer to detect a lost connection. Changes apply to the next attempt or health check.
      </p>
      {CONNECTION_TIMING_FIELDS.map((field) => (
        <SettingsRow key={field.key} title={field.label} description={field.description}>
          <Select
            value={String(settings[field.key])}
            disabled={saving}
            items={field.options.map((value) => ({
              value: String(value),
              label: value === 0 ? "Automatic" : `${value} seconds`,
            }))}
            onValueChange={(value) => {
              if (value !== null) void save({ ...settings, [field.key]: Number(value) });
            }}
          >
            <SelectTrigger size="sm" aria-label={field.label}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {field.options.map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {value === 0 ? "Automatic" : `${value} seconds`}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </SettingsRow>
      ))}
    </SettingsSection>
  );
}
