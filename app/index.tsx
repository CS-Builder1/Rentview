import { Redirect } from "expo-router";

import { useAuth } from "../lib/auth";
import { Loading } from "../components/ui";

export default function Index() {
  const { session, initializing } = useAuth();

  if (initializing) return <Loading />;
  if (!session) return <Redirect href="/(auth)/login" />;
  return <Redirect href="/(app)" />;
}
