import { Component, lazy, Suspense, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "./components/AppText";

const NativeApp = lazy(() => import("./App"));

class NativeWebBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-background p-6">
        <Text className="text-lg text-foreground">Native web preview is unavailable</Text>
        <Text className="text-foreground-muted">You can keep using the standard app.</Text>
      </View>
    );
  }
}

export default function NativeWebRoot() {
  return (
    <View className="flex-1">
      <View className="flex-1">
        <NativeWebBoundary>
          <Suspense
            fallback={
              <View className="flex-1 items-center justify-center">
                <Text>Loading T3 Code…</Text>
              </View>
            }
          >
            <NativeApp />
          </Suspense>
        </NativeWebBoundary>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          window.location.assign("/");
        }}
        className="min-h-11 items-center justify-center bg-background"
      >
        <Text className="text-primary">Open standard app</Text>
      </Pressable>
    </View>
  );
}
