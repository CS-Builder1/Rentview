import { useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { Ionicons } from "@expo/vector-icons";

import { Button, Field, Screen } from "../../components/ui";
import { authRedirectUrl, signInWithGoogle } from "../../lib/oauth";
import { supabase } from "../../lib/supabase";

export default function Login() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

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
          <View className="mb-8">
            <Text className="text-3xl font-bold text-brand">RentView</Text>
            <Text className="mt-1 text-slate-500">
              Operations-first property management.
            </Text>
          </View>

          <Pressable
            onPress={googleSignIn}
            disabled={googleLoading}
            className={`mb-5 flex-row items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-3 ${
              googleLoading ? "opacity-50" : ""
            }`}
          >
            <Ionicons name="logo-google" size={18} color="#0f766e" />
            <Text className="ml-2 font-semibold text-slate-800">
              {googleLoading ? "Connecting…" : "Continue with Google"}
            </Text>
          </Pressable>

          <View className="mb-5 flex-row items-center">
            <View className="h-px flex-1 bg-slate-200" />
            <Text className="mx-3 text-xs uppercase text-slate-400">or</Text>
            <View className="h-px flex-1 bg-slate-200" />
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
            <Text className="text-slate-600">
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
