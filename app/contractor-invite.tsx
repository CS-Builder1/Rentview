import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text } from "react-native";
import { Button, Field, Loading, Screen } from "../components/ui";
import { useAuth } from "../lib/auth";
import { clearAuthDestination, rememberAuthDestination } from "../lib/authDestination";
import { normalizeInviteCode } from "../lib/invites";
import { operationError } from "../lib/operationsQuery";
import { supabase } from "../lib/supabase";

export default function ContractorInvite() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string }>();
  const { session, initializing, refreshProfile } = useAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (typeof params.code === "string") setCode(params.code); }, [params.code]);

  async function claim() {
    if (busy) return;
    setError("");
    const normalized = normalizeInviteCode(code);
    if (!normalized) { setError("Enter the contractor invitation code from the property manager."); return; }
    setBusy(true);
    try {
      if (!session) {
        const next = `/contractor-invite?code=${normalized}`;
        await rememberAuthDestination(next);
        router.push({ pathname: "/(auth)/login", params: { next } });
        return;
      }
      const { error } = await supabase.rpc("claim_contractor_invite", { p_code: normalized });
      if (error) throw error;
      await clearAuthDestination();
      await refreshProfile();
      router.replace("/contractor");
    } catch (err) { setError(operationError(err)); }
    finally { setBusy(false); }
  }

  if (initializing) return <Loading />;
  return <Screen><ScrollView contentContainerClassName="mx-auto w-full max-w-lg gap-4 px-5 py-6" keyboardShouldPersistTaps="handled">
    <Text className="text-2xl font-bold text-slate-900">Join as a contractor</Text>
    <Text className="text-slate-700">Use the email address on your invitation to receive assigned jobs and arrange visits.</Text>
    <Field label="Contractor invitation code" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} maxLength={64} onSubmitEditing={claim}/>
    {error ? <Text accessibilityRole="alert" className="text-red-700">{error}</Text> : null}
    <Button title={session ? "Accept invitation" : "Continue to sign in or create account"} onPress={claim} loading={busy} />
    {session ? <Text className="text-slate-500">Signed in as {session.user.email}</Text> : null}
    <Button title="Back" variant="secondary" onPress={() => router.canGoBack() ? router.back() : router.replace("/")} />
  </ScrollView></Screen>;
}
