import { Redirect, Stack } from "expo-router";

import { useAuth } from "../../lib/auth";
import { Loading } from "../../components/ui";

export default function AuthLayout() {
  const { session, initializing } = useAuth();

  if (initializing) return <Loading />;
  if (session) return <Redirect href="/(app)" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
