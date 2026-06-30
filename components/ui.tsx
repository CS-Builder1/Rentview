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

export function Screen({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView className="flex-1 bg-slate-50" edges={["top"]}>
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
  variant?: "primary" | "secondary" | "danger";
  loading?: boolean;
  disabled?: boolean;
}) {
  const base = "rounded-xl px-4 py-3 items-center justify-center flex-row";
  const styles = {
    primary: "bg-brand",
    secondary: "bg-slate-200",
    danger: "bg-red-600",
  }[variant];
  const textColor = variant === "secondary" ? "text-slate-800" : "text-white";
  const isDisabled = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      className={`${base} ${styles} ${isDisabled ? "opacity-50" : ""}`}
    >
      {loading ? (
        <ActivityIndicator color={variant === "secondary" ? "#1e293b" : "#fff"} />
      ) : (
        <Text className={`font-semibold ${textColor}`}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  ...props
}: TextInputProps & { label: string }) {
  return (
    <View className="mb-3">
      <Text className="mb-1 text-sm font-medium text-slate-600">{label}</Text>
      <TextInput
        className="rounded-xl border border-slate-300 bg-white px-3 py-3 text-slate-900"
        placeholderTextColor="#94a3b8"
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
    <View className="rounded-2xl border border-slate-200 bg-white p-4">
      {children}
    </View>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} className="mb-3">
        {inner}
      </Pressable>
    );
  }
  return <View className="mb-3">{inner}</View>;
}

const badgeColors: Record<string, string> = {
  open: "bg-amber-100 text-amber-800",
  in_progress: "bg-blue-100 text-blue-800",
  on_hold: "bg-slate-200 text-slate-700",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-slate-200 text-slate-500",
  urgent: "bg-red-100 text-red-800",
  high: "bg-orange-100 text-orange-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-100 text-slate-600",
  occupied: "bg-green-100 text-green-800",
  vacant: "bg-slate-100 text-slate-600",
  maintenance: "bg-amber-100 text-amber-800",
  operational: "bg-green-100 text-green-800",
  needs_attention: "bg-amber-100 text-amber-800",
  out_of_service: "bg-red-100 text-red-800",
};

export function Badge({ label }: { label: string }) {
  const color = badgeColors[label] ?? "bg-slate-100 text-slate-600";
  const text = label.replace(/_/g, " ");
  return (
    <View className={`self-start rounded-full px-2.5 py-0.5 ${color.split(" ")[0]}`}>
      <Text className={`text-xs font-medium capitalize ${color.split(" ")[1]}`}>
        {text}
      </Text>
    </View>
  );
}

export function Loading() {
  return (
    <View className="flex-1 items-center justify-center bg-slate-50">
      <ActivityIndicator size="large" color="#0f766e" />
    </View>
  );
}

export function EmptyState({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <View className="items-center justify-center px-8 py-16">
      <Text className="text-center text-lg font-semibold text-slate-700">
        {title}
      </Text>
      {subtitle ? (
        <Text className="mt-1 text-center text-slate-500">{subtitle}</Text>
      ) : null}
    </View>
  );
}
