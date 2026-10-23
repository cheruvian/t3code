import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { environmentShell } from "../state/shell";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  getWebPushSubscription,
  serializeWebPushSubscription,
  setWebPushEnabled,
  useWebPushEnabled,
} from "../webPush";

function EnvironmentPushRegistration({ environmentId }: { environmentId: EnvironmentId }) {
  const enabled = useWebPushEnabled(environmentId);
  const notificationMode = useClientSettings((settings) => settings.notificationMode);
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const connected = shell.status === "live";
  const update = useAtomCommand(serverEnvironment.webPushUpdate, { reportFailure: false });
  useEffect(() => {
    if (!enabled || !connected) return;
    let cancelled = false;
    void getWebPushSubscription(environmentId)
      .then(async (subscription) => {
        if (cancelled) return;
        if (!subscription || Notification.permission !== "granted") {
          setWebPushEnabled(environmentId, false);
          return;
        }
        await update({
          environmentId,
          input: {
            type: "subscribe",
            subscription: serializeWebPushSubscription(subscription),
            notificationMode,
          },
        });
      })
      .catch(() => {
        /* Retain the preference so the next connection can retry. */
      });
    return () => {
      cancelled = true;
    };
  }, [connected, enabled, environmentId, notificationMode, update]);
  return null;
}

export function BackgroundPushCoordinator() {
  return useEnvironmentIds().map((environmentId) => (
    <EnvironmentPushRegistration key={environmentId} environmentId={environmentId} />
  ));
}
