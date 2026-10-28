import { Redirect, Stack } from "expo-router";

import { Loading } from "../../components/ui";
import { useAuth } from "../../lib/auth";

export default function TenantLayout() {
  const { session, initializing } = useAuth();

  if (initializing) return <Loading />;
  if (!session) return <Redirect href="/(auth)/login" />;
  // Access to leases is enforced by RLS, so owners who also rent can use this portal.

  return (
    <Stack key={session.user.id} screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="new-request" />
      <Stack.Screen name="request/[id]" />
    </Stack>
  );
}
