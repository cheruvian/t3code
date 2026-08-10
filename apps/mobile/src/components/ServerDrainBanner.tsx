import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText as Text } from "./AppText";
import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

function EnvironmentDrainBanner({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const result = useAtomValue(serverEnvironment.drain({ environmentId, input: {} }));
  const drain = Option.getOrNull(AsyncResult.value(result));
  const controlDrain = useAtomCommand(serverEnvironment.controlDrain, { reportFailure: true });
  if (drain === null) return null;

  const control = (operation: "cancel" | "force") => {
    void controlDrain({ environmentId, input: { operation, drainId: drain.id } });
  };
  return (
    <View accessibilityRole="alert" style={styles.banner}>
      <Text style={styles.title}>
        {drain.phase === "committing" ? "Shutting down now" : "Server shutting down safely"}
      </Text>
      <Text style={styles.detail}>
        {drain.activeWorkCount === 0
          ? "Active work is settled."
          : `Waiting for ${drain.activeWorkCount} active ${drain.activeWorkCount === 1 ? "session" : "sessions"}.`}
        {drain.blockedThreadIds.length > 0 ? ` ${drain.blockedThreadIds.length} need input.` : ""}
      </Text>
      <View style={styles.actions}>
        {drain.canCancel ? (
          <Pressable onPress={() => control("cancel")} style={styles.button}>
            <Text style={styles.buttonText}>Cancel</Text>
          </Pressable>
        ) : null}
        {drain.canForce ? (
          <Pressable onPress={() => control("force")} style={[styles.button, styles.force]}>
            <Text style={styles.buttonText}>Stop now</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function ServerDrainBanners() {
  const { environments } = useEnvironments();
  return (
    <View pointerEvents="box-none" style={styles.host}>
      {environments.map((environment) => (
        <EnvironmentDrainBanner
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: "absolute", left: 0, right: 0, top: 0, zIndex: 1000 },
  banner: {
    backgroundColor: "#451a03",
    borderBottomColor: "#fbbf24",
    borderBottomWidth: 2,
    padding: 12,
  },
  title: { color: "#fffbeb", fontSize: 14, fontWeight: "800" },
  detail: { color: "#fef3c7", fontSize: 12, marginTop: 2 },
  actions: { flexDirection: "row", gap: 8, marginTop: 8 },
  button: {
    borderColor: "#fcd34d",
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  force: { backgroundColor: "#b91c1c", borderColor: "#fca5a5" },
  buttonText: { color: "#fff", fontSize: 12, fontWeight: "700" },
});
