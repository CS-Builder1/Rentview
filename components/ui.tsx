import { Ionicons } from "@expo/vector-icons";
import { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  TextInputProps,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { fallbackStatusColor, statusColors, useTheme } from "../lib/theme";
import { OfflineBanner } from "./OfflineBanner";

/**
 * Pressable with subtle scale-down feedback while pressed.
 * Uses Pressable's style function (not reanimated) so NativeWind classes
 * keep working — className isn't applied to animated components.
 */
export function PressableScale({
  onPress,
  disabled,
  className,
  children,
}: {
  onPress?: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={className}
      style={({ pressed }) => ({
        transform: [{ scale: pressed ? 0.97 : 1 }],
        opacity: pressed ? 0.9 : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

/** Ionicon that follows the color scheme via semantic tones. */
export function Icon({
  name,
  size = 20,
  tone = "brand",
}: {
  name: keyof typeof Ionicons.glyphMap;
  size?: number;
  tone?: "brand" | "danger" | "muted" | "faint" | "success" | "warning";
}) {
  const { colors } = useTheme();
  const map = {
    brand: colors.brand,
    danger: colors.danger,
    muted: colors.inkMuted,
    faint: colors.inkFaint,
    success: colors.success,
    warning: colors.warning,
  };
  return <Ionicons name={name} size={size} color={map[tone]} />;
}

export function Screen({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView className="flex-1 bg-canvas dark:bg-canvas-dark" edges={["top"]}>
      <OfflineBanner />
      {children}
    </SafeAreaView>
  );
}

export function Button({
  title,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  loading?: boolean;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const base = "rounded-xl px-4 py-3 items-center justify-center flex-row";
  const styles = {
    primary: "bg-brand dark:bg-brand-600",
    secondary: "bg-slate-200 dark:bg-surface-dark-raised",
    danger: "bg-red-600 dark:bg-red-700",
    ghost: "border border-slate-300 dark:border-slate-700",
  }[variant];
  const textColor = {
    primary: "text-white",
    secondary: "text-slate-800 dark:text-slate-100",
    danger: "text-white",
    ghost: "text-slate-700 dark:text-slate-200",
  }[variant];
  const isDisabled = disabled || loading;

  return (
    <PressableScale
      onPress={onPress}
      disabled={isDisabled}
      className={`${base} ${styles} ${isDisabled ? "opacity-50" : ""}`}
    >
      {loading ? (
        <ActivityIndicator
          color={variant === "secondary" || variant === "ghost" ? colors.ink : "#fff"}
        />
      ) : (
        <Text className={`font-semibold ${textColor}`}>{title}</Text>
      )}
    </PressableScale>
  );
}

export function Field({
  label,
  ...props
}: TextInputProps & { label: string }) {
  const { colors } = useTheme();
  return (
    <View className="mb-3">
      <Text className="mb-1 text-sm font-medium text-slate-600 dark:text-slate-300">
        {label}
      </Text>
      <TextInput
        className="rounded-xl border border-slate-300 bg-white px-3 py-3 text-slate-900 dark:border-slate-700 dark:bg-surface-dark-raised dark:text-slate-100"
        placeholderTextColor={colors.inkFaint}
        {...props}
      />
    </View>
  );
}

export function Card({
  children,
  onPress,
}: {
  children: ReactNode;
  onPress?: () => void;
}) {
  const inner = (
    <View className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-surface-dark">
      {children}
    </View>
  );
  if (onPress) {
    return (
      <PressableScale onPress={onPress} className="mb-3">
        {inner}
      </PressableScale>
    );
  }
  return <View className="mb-3">{inner}</View>;
}

export function Badge({ label }: { label: string }) {
  const color = statusColors[label] ?? fallbackStatusColor;
  const text = label.replace(/_/g, " ");
  return (
    <View className={`self-start rounded-full px-2.5 py-0.5 ${color.bg}`}>
      <Text className={`text-xs font-medium capitalize ${color.text}`}>{text}</Text>
    </View>
  );
}

export function Loading() {
  const { colors } = useTheme();
  return (
    <View className="flex-1 items-center justify-center bg-canvas dark:bg-canvas-dark">
      <ActivityIndicator size="large" color={colors.brand} />
    </View>
  );
}

export function EmptyState({
  title,
  subtitle,
  icon,
}: {
  title: string;
  subtitle?: string;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const { colors } = useTheme();
  return (
    <View className="items-center justify-center px-8 py-16">
      {icon ? (
        <View className="mb-4 h-16 w-16 items-center justify-center rounded-full bg-brand-50 dark:bg-brand-950">
          <Ionicons name={icon} size={28} color={colors.brand} />
        </View>
      ) : null}
      <Text className="text-center text-lg font-semibold text-slate-700 dark:text-slate-200">
        {title}
      </Text>
      {subtitle ? (
        <Text className="mt-1 text-center text-slate-500 dark:text-slate-400">
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}
