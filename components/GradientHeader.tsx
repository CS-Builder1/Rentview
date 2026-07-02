/**
 * GradientHeader — brand-teal hero header used on the owner dashboard and
 * tenant home. Carries a greeting plus a headline summary; children render
 * on the gradient (text should be white/teal-tinted).
 */
import { LinearGradient } from "expo-linear-gradient";
import type { ReactNode } from "react";
import { Text, View } from "react-native";

import { brandGradient } from "../lib/theme";

export function GradientHeader({
  greeting,
  title,
  subtitle,
  right,
  children,
}: {
  /** Small line above the title (e.g. "Good morning, Alex"). */
  greeting?: string;
  title: string;
  subtitle?: string;
  /** Node pinned to the right of the title row (e.g. a ring or icon button). */
  right?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <LinearGradient
      colors={[...brandGradient]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      // Styled via the style prop: NativeWind classes don't reach
      // third-party components like LinearGradient.
      style={{
        borderBottomLeftRadius: 28,
        borderBottomRightRadius: 28,
        overflow: "hidden",
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: 24,
      }}
    >
      {greeting ? (
        <Text className="text-sm font-medium text-brand-100">{greeting}</Text>
      ) : null}
      <View className="mt-1 flex-row items-center justify-between">
        <View className="flex-1 pr-3">
          <Text className="text-2xl font-bold text-white">{title}</Text>
          {subtitle ? <Text className="mt-1 text-sm text-brand-100">{subtitle}</Text> : null}
        </View>
        {right}
      </View>
      {children}
    </LinearGradient>
  );
}
