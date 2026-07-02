import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";

import { useTheme } from "../../../lib/theme";

function tabIcon(outline: keyof typeof Ionicons.glyphMap, filled: keyof typeof Ionicons.glyphMap) {
  return ({ color, size, focused }: { color: string; size: number; focused: boolean }) => (
    <Ionicons name={focused ? filled : outline} color={color} size={size} />
  );
}

export default function TenantTabsLayout() {
  const { colors } = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.inkFaint,
        tabBarStyle: {
          backgroundColor: colors.chrome,
          borderTopColor: colors.border,
        },
        tabBarLabelStyle: { fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Home", tabBarIcon: tabIcon("home-outline", "home") }}
      />
      <Tabs.Screen
        name="requests"
        options={{ title: "Requests", tabBarIcon: tabIcon("construct-outline", "construct") }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: "More",
          tabBarIcon: tabIcon("ellipsis-horizontal-outline", "ellipsis-horizontal"),
        }}
      />
    </Tabs>
  );
}
