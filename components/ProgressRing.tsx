/**
 * ProgressRing — a circular meter for a single ratio (e.g. occupancy).
 * Per dataviz guidance: the unfilled track is a lighter step of the same ramp
 * as the fill, and the center value wears ink tokens, never the data color.
 */
import { Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { useTheme } from "../lib/theme";

export function ProgressRing({
  progress,
  size = 64,
  strokeWidth = 7,
  label,
  valueText,
}: {
  /** 0..1 */
  progress: number;
  size?: number;
  strokeWidth?: number;
  /** Small caption under the value inside the ring. */
  label?: string;
  /** Text in the ring center; defaults to a percentage. */
  valueText?: string;
}) {
  const { isDark } = useTheme();
  const clamped = Math.max(0, Math.min(1, progress));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  // Same-ramp pair: brand fill on a lighter brand track (dark mode inverts).
  const fill = isDark ? "#2dd4bf" : "#0f766e";
  const track = isDark ? "#134e4a" : "#ccfbf1";

  return (
    <View style={{ width: size, height: size }} className="items-center justify-center">
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={track}
          strokeWidth={strokeWidth}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={fill}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${circumference}`}
          strokeDashoffset={circumference * (1 - clamped)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View className="absolute items-center">
        <Text className="text-sm font-bold text-slate-900 dark:text-slate-100">
          {valueText ?? `${Math.round(clamped * 100)}%`}
        </Text>
        {label ? (
          <Text className="text-[10px] text-slate-500 dark:text-slate-400">{label}</Text>
        ) : null}
      </View>
    </View>
  );
}
