import { Redirect, Stack } from "expo-router";

import { Loading } from "../../components/ui";
import { useAuth } from "../../lib/auth";

export default function TenantLayout() {
  const { session, initializing, role } = useAuth();

  if (initializing) return <Loading />;
  if (!session) return <Redirect href="/(auth)/login" />;
  // Owners never see the portal; they manage it from the owner app.
  if (role !== "tenant") return <Redirect href="/(app)" />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="new-request" />
      <Stack.Screen name="request/[id]" />
    </Stack>
  );
}
