import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

function LoadingStripFrame(props: { readonly children: React.ReactNode }) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden"
    >
      {props.children}
    </View>
  );
}

function IndeterminateLoadingStrip() {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = 1;
    opacity.value = withRepeat(
      withTiming(0.35, {
        duration: 1100,
        easing: Easing.inOut(Easing.quad),
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      true,
    );

    return () => {
      cancelAnimation(opacity);
    };
  }, [opacity]);

  const indicatorStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <LoadingStripFrame>
      <Animated.View
        className="mx-auto h-full w-1/3 rounded-full bg-primary"
        style={indicatorStyle}
      />
    </LoadingStripFrame>
  );
}

export function LoadingStrip(props: { readonly progress?: number }) {
  if (props.progress === undefined) {
    return <IndeterminateLoadingStrip />;
  }

  const clampedProgress = Math.min(1, Math.max(0, props.progress));

  return (
    <LoadingStripFrame>
      <View
        className="h-full rounded-r-full bg-primary"
        style={{ width: `${clampedProgress * 100}%` }}
      />
    </LoadingStripFrame>
  );
}
