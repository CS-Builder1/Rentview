import { Pressable, Text, View } from "react-native";
import { titleCase } from "../lib/format";

type Choice = { value: string; label: string };
export function HistoryChoices({
  label,
  choices,
  selected,
  onSelect,
  disabled = false,
}: {
  label: string;
  choices: readonly (Choice | string)[];
  selected: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <View className="mb-3">
      <Text className="mb-1 font-medium text-slate-700">{label}</Text>
      <View className="flex-row flex-wrap gap-2">
        {choices.map((choice) => {
          const { value, label: text } =
            typeof choice === "string"
              ? { value: choice, label: titleCase(choice) }
              : choice;
          const active = value === selected;
          return (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: active, disabled }}
              disabled={disabled}
              onPress={() => onSelect(value)}
              className={
                active
                  ? "rounded-full bg-brand px-3 py-2"
                  : "rounded-full border border-slate-300 bg-white px-3 py-2"
              }
            >
              <Text
                className={active ? "font-medium text-white" : "text-slate-700"}
              >
                {text}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
