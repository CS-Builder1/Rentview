/**
 * Skeleton loaders — animated placeholders shown while lists/dashboards fetch.
 * Replaces full-screen spinners so screens keep their layout during loads.
 */
import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

function Pulse({ className }: { className?: string }) {
  const opacity = useSharedValue(0.5);

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(1, { duration: 700, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  // className lives on an inner core View — NativeWind doesn't style
  // reanimated components, so the animated wrapper only carries opacity.
  return (
    <Animated.View style={style}>
      <View className={`rounded-lg bg-slate-200 dark:bg-slate-800 ${className ?? ""}`} />
    </Animated.View>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <Pulse className={className} />;
}

/** Placeholder matching a typical list Card (title + subtitle + badge). */
export function SkeletonCard() {
  return (
    <View className="mb-3 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-surface-dark">
      <View className="flex-row items-center justify-between">
        <Pulse className="h-4 w-40" />
        <Pulse className="h-5 w-16 rounded-full" />
      </View>
      <Pulse className="mt-3 h-3 w-56" />
      <Pulse className="mt-2 h-3 w-24" />
    </View>
  );
}

/** A column of list-card placeholders. */
export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <View className="px-4 pt-4">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </View>
  );
}

/** Placeholder for a dashboard stat tile. */
export function SkeletonStat() {
  return (
    <View className="w-[48%] rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-surface-dark">
      <Pulse className="h-3 w-20" />
      <Pulse className="mt-3 h-7 w-14" />
    </View>
  );
}
