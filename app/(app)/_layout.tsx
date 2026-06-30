import { Redirect, Stack } from "expo-router";

import { useAuth } from "../../lib/auth";
import { Loading } from "../../components/ui";

export default function AppLayout() {
  const { session, initializing } = useAuth();

  if (initializing) return <Loading />;
  if (!session) return <Redirect href="/(auth)/login" />;

  // A Stack with the tab bar as the first screen. Detail and management
  // pages push ON TOP of the tabs, so "back" returns to the exact screen
  // (and tab) you came from — not the first tab.
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="property/[id]" />
      <Stack.Screen name="work-order/[id]" />
      <Stack.Screen name="asset/[id]" />
      <Stack.Screen name="assets" />
      <Stack.Screen name="inventory" />
      <Stack.Screen name="expenses" />
      <Stack.Screen name="maintenance" />
      <Stack.Screen name="documents" />
    </Stack>
  );
}
