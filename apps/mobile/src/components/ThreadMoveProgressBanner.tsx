import { getActiveThreadMoves, subscribeThreadMoves } from "@t3tools/client-runtime/operations";
import { useSyncExternalStore } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "./AppText";

/** Remains visible while navigating between threads during a client-mediated move. */
export function ThreadMoveProgressBanner() {
  const moves = useSyncExternalStore(subscribeThreadMoves, getActiveThreadMoves);
  const insets = useSafeAreaInsets();
  if (moves.length === 0) return null;
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", top: insets.top, left: 12, right: 12 }}
    >
      {moves.map((move) => (
        <View
          key={move.key}
          accessibilityRole="alert"
          className="mb-2 rounded-2xl border border-border bg-card px-3.5 py-3"
        >
          <AppText className="font-t3-medium text-sm">
            Moving thread to {move.destinationLabel}
          </AppText>
          <AppText className="text-xs text-foreground-muted">{move.description}</AppText>
        </View>
      ))}
    </View>
  );
}
