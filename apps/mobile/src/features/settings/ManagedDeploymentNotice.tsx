import { useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Alert, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";

export function ManagedDeploymentNotice({ environmentId }: { environmentId: EnvironmentId }) {
  const canAct = useAtomValue(serverEnvironment.deploymentAction.permissionAtom(environmentId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return canAct && config?.environment.capabilities.managedDeployments ? (
    <Notice environmentId={environmentId} />
  ) : null;
}
function Notice({ environmentId }: { environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const result = useAtomValue(serverEnvironment.deploymentState({ environmentId, input: {} }));
  const act = useAtomCommand(serverEnvironment.deploymentAction);
  const state = AsyncResult.isSuccess(result) ? result.value : null;
  if (!state) return null;
  const apply = () =>
    Alert.alert(
      "Update now?",
      "Running threads will be interrupted while this environment restarts.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Update now",
          style: "destructive",
          onPress: () => {
            void act({ environmentId, input: { id: state.id, action: "force" } });
          },
        },
      ],
    );
  return (
    <SettingsSection title="Deployment">
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">
          {state.status === "queued"
            ? "Update queued"
            : state.status === "installing"
              ? "Installing update"
              : "Update failed"}{" "}
          · {state.revision.slice(0, 7)}
        </Text>
        {state.status === "queued" ? (
          <Text className="text-sm text-foreground-muted">
            Waiting for {state.busyThreads} {state.busyThreads === 1 ? "thread" : "threads"} and
            pending work.
          </Text>
        ) : null}
      </View>
      {state.status === "queued"
        ? state.blockingThreads?.map((thread) => (
            <SettingsActionRow
              key={thread.threadId}
              icon="bubble.left.and.bubble.right"
              label={thread.title}
              description="Open blocking thread"
              onPress={() =>
                navigation.navigate("Thread", { environmentId, threadId: thread.threadId })
              }
            />
          ))
        : null}
      {state.status === "queued" ? (
        <SettingsActionRow icon="arrow.clockwise" label="Update now" onPress={apply} />
      ) : null}
      {state.status !== "installing" ? (
        <SettingsActionRow
          icon="xmark"
          label="Cancel update"
          onPress={() => {
            void act({ environmentId, input: { id: state.id, action: "cancel" } });
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
