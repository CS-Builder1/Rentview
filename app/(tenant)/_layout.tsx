import { Redirect, Stack } from "expo-router";

import { useAuth } from "../../lib/auth";
import { Loading } from "../../components/ui";

export default function TenantLayout() {
  const { session, initializing, role, roleLoading } = useAuth();

  if (initializing || roleLoading) return <Loading />;
  if (!session) return <Redirect href="/(auth)/login" />;
  if (role !== "tenant") return <Redirect href="/(app)" />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="request/[id]" />
    </Stack>
  );
}
