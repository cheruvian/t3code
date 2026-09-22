import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { resourceActionLogs, formatResourceActionLog } from "@t3tools/shared/resourceActions";
import { AppText } from "../../components/AppText";

export function ResourceActionLogs({
  activities,
}: {
  activities: readonly OrchestrationThreadActivity[];
}) {
  const [open, setOpen] = useState(false);
  const logs = useMemo(() => resourceActionLogs(activities), [activities]);
  if (logs.length === 0) return null;
  return (
    <>
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)} className="px-4 py-2">
        <AppText className="text-xs">Resource logs</AppText>
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <View className="flex-1 bg-screen px-4 pt-12 pb-6">
          <View className="flex-row items-center justify-between mb-4">
            <AppText>Resource action logs</AppText>
            <Pressable accessibilityRole="button" onPress={() => setOpen(false)}>
              <AppText>Close</AppText>
            </Pressable>
          </View>
          <ScrollView>
            {logs.map((log) => (
              <AppText key={log.operationId} selectable className="mb-6 text-xs">
                {formatResourceActionLog(log)}
              </AppText>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}
