/**
 * Avatar — initials chip for tenants, vendors and message senders.
 * Color is deterministic per name (identity follows the entity).
 */
import { Text, View } from "react-native";

const palette = [
  { bg: "bg-brand-100 dark:bg-brand-900", text: "text-brand-800 dark:text-brand-200" },
  { bg: "bg-blue-100 dark:bg-blue-900", text: "text-blue-800 dark:text-blue-200" },
  { bg: "bg-violet-100 dark:bg-violet-900", text: "text-violet-800 dark:text-violet-200" },
  { bg: "bg-amber-100 dark:bg-amber-900", text: "text-amber-800 dark:text-amber-200" },
  { bg: "bg-rose-100 dark:bg-rose-900", text: "text-rose-800 dark:text-rose-200" },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function hash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function Avatar({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md" | "lg";
}) {
  const color = palette[hash(name) % palette.length];
  const dims = { sm: "h-7 w-7", md: "h-9 w-9", lg: "h-12 w-12" }[size];
  const font = { sm: "text-[10px]", md: "text-xs", lg: "text-base" }[size];

  return (
    <View className={`items-center justify-center rounded-full ${dims} ${color.bg}`}>
      <Text className={`font-bold ${font} ${color.text}`}>{initials(name)}</Text>
    </View>
  );
}
