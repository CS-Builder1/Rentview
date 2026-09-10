import { Ionicons } from "@expo/vector-icons";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Card, Field, Loading, Screen } from "../components/ui";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";

function notify(title: string, message: string) {
  Platform.OS === "web"
    ? window.alert(`${title}\n\n${message}`)
    : Alert.alert(title, message);
}

/**
 * Tenant invite claim. Reachable from the owner app (a fresh account is an
 * owner until it claims) and from the tenant portal, so a tenant with a second
 * lease can link it to the same login.
 */
export default function ClaimInvite() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string }>();
  const { session, initializing, refreshProfile } = useAuth();
  const [code, setCode] = useState(params.code ?? "");
  const [claiming, setClaiming] = useState(false);

  if (initializing) return <Loading />;
  if (!session) return <Redirect href="/(auth)/login" />;

  async function claim() {
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length < 6) {
      notify("Check the code", "Invite codes are at least 6 characters.");
      return;
    }
    setClaiming(true);
    try {
      const { error } = await supabase.rpc("claim_tenant_invite", {
        invite_code: trimmed,
      });
      if (error) throw error;
      const nextRole = await refreshProfile();
      // An account that also owns properties keeps its owner role — the RPC
      // never demotes a landlord — so send it back to the owner app instead
      // of a portal it cannot enter.
      if (nextRole === "tenant") {
        router.replace("/tenant");
      } else {
        notify(
          "Lease linked",
          "This account manages properties, so it stays in the owner app.",
        );
        router.replace("/");
      }
    } catch (e) {
      notify("Could not join", e instanceof Error ? e.message : String(e));
    } finally {
      setClaiming(false);
    }
  }

  return (
    <Screen>
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          className="p-2"
        >
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text className="flex-1 text-xl font-bold text-slate-900">
          Join with an invite code
        </Text>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10" keyboardShouldPersistTaps="handled">
        <Card>
          <Text className="text-slate-600">
            Your landlord can generate a code for your unit. Entering it links
            this login to your lease and opens your tenant portal — where you
            can report repairs, follow their progress, and see your rent
            history.
          </Text>
        </Card>

        <Field
          label="Invite code"
          value={code}
          onChangeText={(t) => setCode(t.toUpperCase())}
          placeholder="ABCD1234"
          autoCapitalize="characters"
          autoCorrect={false}
        />

        <Button title="Join" onPress={claim} loading={claiming} />

        <Text className="mt-4 text-center text-xs text-slate-400">
          Signed in as {session.user.email}
        </Text>
      </ScrollView>
    </Screen>
  );
}
