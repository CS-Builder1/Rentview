/**
 * RentView design tokens.
 *
 * Single source of truth for the colors that must be passed as raw hex —
 * navigators, ActivityIndicator, Ionicons, SVG, StatusBar — where Tailwind
 * classes can't reach. Screen/component styling should prefer NativeWind
 * classes (with dark: variants); this module keeps the two in sync.
 */
import { useColorScheme } from "react-native";

export type ThemeColors = {
  /** Page background (matches `bg-canvas` / `dark:bg-canvas-dark`). */
  bg: string;
  /** Card / sheet background. */
  surface: string;
  /** Elevated surface (inputs, chips on cards). */
  surfaceRaised: string;
  /** Hairline borders. */
  border: string;
  /** Primary text. */
  ink: string;
  /** Secondary text. */
  inkMuted: string;
  /** Tertiary text / placeholders. */
  inkFaint: string;
  /** Brand teal (buttons, active tab, links). */
  brand: string;
  /** Soft brand wash (selected chips, highlights). */
  brandSoft: string;
  danger: string;
  warning: string;
  success: string;
  info: string;
  /** Tab bar / nav chrome background. */
  chrome: string;
};

export const lightColors: ThemeColors = {
  bg: "#f8fafc",
  surface: "#ffffff",
  surfaceRaised: "#f1f5f9",
  border: "#e2e8f0",
  ink: "#0f172a",
  inkMuted: "#475569",
  inkFaint: "#94a3b8",
  brand: "#0f766e",
  brandSoft: "#ccfbf1",
  danger: "#dc2626",
  warning: "#d97706",
  success: "#16a34a",
  info: "#2563eb",
  chrome: "#ffffff",
};

export const darkColors: ThemeColors = {
  bg: "#020617",
  surface: "#0f172a",
  surfaceRaised: "#1e293b",
  border: "#1e293b",
  ink: "#f1f5f9",
  inkMuted: "#94a3b8",
  inkFaint: "#64748b",
  brand: "#2dd4bf",
  brandSoft: "#134e4a",
  danger: "#f87171",
  warning: "#fbbf24",
  success: "#4ade80",
  info: "#60a5fa",
  chrome: "#0f172a",
};

/** Gradient stops for hero headers (same in both schemes — brand identity). */
export const brandGradient = ["#115e59", "#0f766e", "#0d9488"] as const;

export function useTheme(): { colors: ThemeColors; isDark: boolean } {
  const scheme = useColorScheme();
  const isDark = scheme === "dark";
  return { colors: isDark ? darkColors : lightColors, isDark };
}

/**
 * Status/priority → badge classes, shared by every Badge on both portals.
 * Each entry is "<bg classes> <text classes>" including dark variants.
 */
export const statusColors: Record<string, { bg: string; text: string }> = {
  // Work orders
  open: { bg: "bg-amber-100 dark:bg-amber-950", text: "text-amber-800 dark:text-amber-300" },
  in_progress: { bg: "bg-blue-100 dark:bg-blue-950", text: "text-blue-800 dark:text-blue-300" },
  on_hold: { bg: "bg-slate-200 dark:bg-slate-800", text: "text-slate-700 dark:text-slate-300" },
  completed: { bg: "bg-green-100 dark:bg-green-950", text: "text-green-800 dark:text-green-300" },
  cancelled: { bg: "bg-slate-200 dark:bg-slate-800", text: "text-slate-500 dark:text-slate-400" },
  // Priority / urgency
  urgent: { bg: "bg-red-100 dark:bg-red-950", text: "text-red-800 dark:text-red-300" },
  high: { bg: "bg-orange-100 dark:bg-orange-950", text: "text-orange-800 dark:text-orange-300" },
  medium: { bg: "bg-amber-100 dark:bg-amber-950", text: "text-amber-800 dark:text-amber-300" },
  low: { bg: "bg-slate-100 dark:bg-slate-800", text: "text-slate-600 dark:text-slate-400" },
  // Units
  occupied: { bg: "bg-green-100 dark:bg-green-950", text: "text-green-800 dark:text-green-300" },
  vacant: { bg: "bg-slate-100 dark:bg-slate-800", text: "text-slate-600 dark:text-slate-400" },
  maintenance: { bg: "bg-amber-100 dark:bg-amber-950", text: "text-amber-800 dark:text-amber-300" },
  unavailable: { bg: "bg-slate-200 dark:bg-slate-800", text: "text-slate-500 dark:text-slate-400" },
  // Assets
  operational: { bg: "bg-green-100 dark:bg-green-950", text: "text-green-800 dark:text-green-300" },
  needs_attention: { bg: "bg-amber-100 dark:bg-amber-950", text: "text-amber-800 dark:text-amber-300" },
  out_of_service: { bg: "bg-red-100 dark:bg-red-950", text: "text-red-800 dark:text-red-300" },
  retired: { bg: "bg-slate-200 dark:bg-slate-800", text: "text-slate-500 dark:text-slate-400" },
  // Leases
  active: { bg: "bg-green-100 dark:bg-green-950", text: "text-green-800 dark:text-green-300" },
  pending: { bg: "bg-amber-100 dark:bg-amber-950", text: "text-amber-800 dark:text-amber-300" },
  expired: { bg: "bg-slate-200 dark:bg-slate-800", text: "text-slate-500 dark:text-slate-400" },
  terminated: { bg: "bg-red-100 dark:bg-red-950", text: "text-red-800 dark:text-red-300" },
  // Tenant maintenance requests
  submitted: { bg: "bg-brand-100 dark:bg-brand-950", text: "text-brand-800 dark:text-brand-300" },
  acknowledged: { bg: "bg-blue-100 dark:bg-blue-950", text: "text-blue-800 dark:text-blue-300" },
  resolved: { bg: "bg-green-100 dark:bg-green-950", text: "text-green-800 dark:text-green-300" },
  closed: { bg: "bg-slate-200 dark:bg-slate-800", text: "text-slate-500 dark:text-slate-400" },
};

export const fallbackStatusColor = {
  bg: "bg-slate-100 dark:bg-slate-800",
  text: "text-slate-600 dark:text-slate-400",
};
