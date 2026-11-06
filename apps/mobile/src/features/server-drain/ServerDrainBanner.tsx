import { useAtomValue } from "@effect/atom-react";
import { AuthEnvironmentMaintainScope, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

function EnvironmentDrainBanner({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const result = useAtomValue(serverEnvironment.drain({ environmentId, input: {} }));
  const canMaintain = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const control = useAtomCommand(serverEnvironment.controlDrain);
  const [pending, setPending] = useState(false);
  const drain = AsyncResult.getOrElse(result, () => null);
  if (drain === null) return null;
  const act = async (operation: "cancel" | "force") => {
    setPending(true);
    await (async () => {
      await control({ environmentId, input: { operation, drainId: drain.id } });
    })().finally(() => {
      setPending(false);
    });
  };
  return (
    <View accessibilityLiveRegion="polite" className="gap-2 border-b border-border bg-screen p-3">
      <AppText>
        {label}:{" "}
        {drain.activeWorkCount === 0
          ? `Ready to ${drain.action}.`
          : `Waiting for ${drain.activeWorkCount} active agents before ${drain.action}.`}
        {drain.blockedThreadIds.length > 0 ? ` ${drain.blockedThreadIds.length} need input.` : ""}
      </AppText>
      {drain.phase === "action-required" ? (
        <AppText>Continue waiting, cancel, or stop the agents to continue.</AppText>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {canMaintain && drain.canCancel ? (
          <Button
            size="compact"
            label={`Cancel ${drain.action}`}
            disabled={pending}
            onPress={() => void act("cancel")}
          />
        ) : null}
        {canMaintain && drain.canForce ? (
          <Button
            size="compact"
            tone="danger"
            label="Stop agents and continue"
            disabled={pending}
            onPress={() => void act("force")}
          />
        ) : null}
      </View>
    </View>
  );
}

export function ServerDrainBanner() {
  const configs = useServerConfigs();
  return (
    <>
      {Array.from(configs, ([environmentId, config]) =>
        config.environment.capabilities.serverDrain === true ? (
          <EnvironmentDrainBanner
            key={environmentId}
            environmentId={environmentId}
            label={config.environment.label}
          />
        ) : null,
      )}
    </>
  );
}
