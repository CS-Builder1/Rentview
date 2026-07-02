import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";

import { Button, Field, Screen, Icon } from "../../components/ui";
import { brandGradient } from "../../lib/theme";
import { setPendingInviteCode } from "../../lib/invites";
import { authRedirectUrl, signInWithGoogle } from "../../lib/oauth";
import { supabase } from "../../lib/supabase";

export default function Login() {
  const params = useLocalSearchParams<{ code?: string }>();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [showInvite, setShowInvite] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  // Deep link "…/login?code=XYZ" (from a landlord's shared invite) pre-fills
  // the code and flips straight into signup mode.
  useEffect(() => {
    if (typeof params.code === "string" && params.code) {
      setInviteCode(params.code.toUpperCase());
      setShowInvite(true);
      setMode("signup");
    }
  }, [params.code]);

  /** Persist the invite code so it survives the signup/OAuth redirect. */
  async function stashInvite() {
    if (inviteCode.trim()) await setPendingInviteCode(inviteCode);
  }

  function notify(title: string, message: string) {
    if (Platform.OS === "web") {
      // RN Alert is a no-op on web.
      window.alert(`${title}\n\n${message}`);
    } else {
      Alert.alert(title, message);
    }
  }

  async function googleSignIn() {
    setGoogleLoading(true);
    try {
      await stashInvite();
      await signInWithGoogle();
    } catch (e) {
      notify("Google sign-in failed", e instanceof Error ? e.message : String(e));
    } finally {
      setGoogleLoading(false);
    }
  }

  async function submit() {
    if (!email || !password) {
      notify("Missing details", "Enter your email and password.");
      return;
    }
    setLoading(true);
    try {
      await stashInvite();
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: fullName },
            emailRedirectTo: authRedirectUrl(),
          },
        });
        if (error) throw error;
        notify(
          "Check your inbox",
          "If email confirmation is on, confirm your address, then sign in.",
        );
        setMode("signin");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      }
    } catch (e) {
      notify("Something went wrong", e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1"
      >
        <ScrollView
          contentContainerClassName="flex-grow justify-center px-6"
          keyboardShouldPersistTaps="handled"
        >
          <View className="mb-8 items-center">
            <LinearGradient
              colors={[...brandGradient]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{
                borderRadius: 20,
                width: 64,
                height: 64,
                marginBottom: 16,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name="home" size={30} color="#fff" />
            </LinearGradient>
            <Text className="text-3xl font-bold text-slate-900 dark:text-slate-100">
              RentView
            </Text>
            <Text className="mt-1 text-center text-slate-500 dark:text-slate-400">
              Property management for owners and tenants.
            </Text>
          </View>

          <Pressable
            onPress={googleSignIn}
            disabled={googleLoading}
            className={`mb-5 flex-row items-center justify-center rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-surface-dark px-4 py-3 ${
              googleLoading ? "opacity-50" : ""
            }`}
          >
            <Icon name="logo-google" size={18} />
            <Text className="ml-2 font-semibold text-slate-800 dark:text-slate-200">
              {googleLoading ? "Connecting…" : "Continue with Google"}
            </Text>
          </Pressable>

          <View className="mb-5 flex-row items-center">
            <View className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
            <Text className="mx-3 text-xs uppercase text-slate-400 dark:text-slate-500">or</Text>
            <View className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
          </View>

          {mode === "signup" ? (
            <Field
              label="Full name"
              value={fullName}
              onChangeText={setFullName}
              placeholder="Your name"
              autoCapitalize="words"
            />
          ) : null}

          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
          />
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            secureTextEntry
          />

          {showInvite ? (
            <Field
              label="Tenant invite code"
              value={inviteCode}
              onChangeText={(v) => setInviteCode(v.toUpperCase())}
              placeholder="e.g. K7PWQ2XR"
              autoCapitalize="characters"
            />
          ) : (
            <Pressable
              onPress={() => setShowInvite(true)}
              className="mb-3 flex-row items-center"
            >
              <Icon name="key-outline" size={16} />
              <Text className="ml-1.5 text-sm font-medium text-brand dark:text-brand-400">
                Renting? Enter your invite code
              </Text>
            </Pressable>
          )}

          <View className="mt-2">
            <Button
              title={mode === "signin" ? "Sign in" : "Create account"}
              onPress={submit}
              loading={loading}
            />
          </View>

          <Pressable
            onPress={() => setMode(mode === "signin" ? "signup" : "signin")}
            className="mt-5 items-center"
          >
            <Text className="text-slate-600 dark:text-slate-300">
              {mode === "signin"
                ? "No account yet? Create one"
                : "Already have an account? Sign in"}
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
