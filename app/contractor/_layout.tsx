import { Redirect, Stack, usePathname } from "expo-router";
import { Loading } from "../../components/ui";
import { useAuth } from "../../lib/auth";

export default function ContractorLayout() {
  const { session, initializing } = useAuth();
  const pathname = usePathname();
  if (initializing) return <Loading />;
  if (!session) return <Redirect href={{ pathname: "/(auth)/login", params: { next: pathname } }} />;
  return <Stack key={session.user.id} screenOptions={{ headerShown: false }} />;
}
