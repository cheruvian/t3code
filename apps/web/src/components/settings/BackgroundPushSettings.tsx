import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  getWebPushSubscription,
  serializeWebPushSubscription,
  setWebPushEnabled,
  subscribeWebPush,
  useWebPushEnabled,
  webPushAvailability,
} from "../../webPush";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSearchTarget } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

function EnvironmentPushSettings({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const enabled = useWebPushEnabled(environmentId);
  const notificationMode = useClientSettings((settings) => settings.notificationMode);
  const permitted = useAtomValue(serverEnvironment.webPushUpdate.permissionAtom(environmentId));
  const config = useAtomCommand(serverEnvironment.webPushConfig, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.webPushUpdate, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const unavailable = webPushAvailability();

  const blocked =
    typeof Notification !== "undefined" && Notification.permission === "denied" && enabled
      ? "Notifications are blocked. Allow them in browser or system settings, or disable background push here."
      : null;

  const change = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (enabled) {
        const subscription = await getWebPushSubscription(environmentId);
        if (subscription) {
          const result = await update({
            environmentId,
            input: { type: "unsubscribe", endpoint: subscription.endpoint },
          });
          if (!AsyncResult.isSuccess(result))
            throw new Error("Could not disable push on this environment. Reconnect and try again.");
          setWebPushEnabled(environmentId, false);
          await subscription.unsubscribe();
        } else setWebPushEnabled(environmentId, false);
      } else {
        // Permission must be requested directly from the button gesture on iOS.
        if ((await Notification.requestPermission()) !== "granted") {
          throw new Error("Allow notifications in browser or system settings, then try again.");
        }
        const result = await config({ environmentId, input: {} });
        if (!AsyncResult.isSuccess(result))
          throw new Error("Could not connect to this environment's push service.");
        const subscription = await subscribeWebPush(environmentId, result.value.publicKey);
        const saved = await update({
          environmentId,
          input: {
            type: "subscribe",
            subscription: serializeWebPushSubscription(subscription),
            notificationMode,
          },
        });
        if (!AsyncResult.isSuccess(saved))
          throw new Error("Could not enable push on this environment. Reconnect and try again.");
        setWebPushEnabled(environmentId, true);
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not change background push settings.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsRow
      title={`Background push · ${label}`}
      description={
        message ??
        blocked ??
        unavailable ??
        "Receive alerts while T3 Code is closed. Thread alerts follow Thread notifications above. Custom API alerts are independent. The environment must stay running and online."
      }
      status={enabled ? "Enabled on this device" : "Off on this device"}
      control={
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !permitted || (!enabled && unavailable !== null)}
          onClick={() => void change()}
        >
          {busy ? "Saving…" : enabled ? "Disable push" : "Enable push"}
        </Button>
      }
    />
  );
}

export function BackgroundPushSettings() {
  const { connectedEnvironments } = useSettingsScope();
  return (
    <SettingsSearchTarget id={searchableSetting("background-push").id}>
      {connectedEnvironments.map((environment) => (
        <EnvironmentPushSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
        />
      ))}
    </SettingsSearchTarget>
  );
}
