import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { Button, Field, Loading, Screen } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { clearAuthDestination, pendingAuthDestination, rememberAuthDestination } from "../../lib/authDestination";
import { safeReturnPath } from "../../lib/invites";
import { authRedirectUrl, signInWithGoogle } from "../../lib/oauth";
import { supabase } from "../../lib/supabase";

type Mode = "signin" | "signup" | "recovery";
export default function Login() {
  const { session, initializing, role } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ next?: string; mode?: string }>();
  const [mode, setMode] = useState<Mode>(params.mode === "signup" ? "signup" : "signin");
  const [next, setNext] = useState(safeReturnPath(params.next));
  const [destinationReady, setDestinationReady] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const authAction = useRef(false);
  useEffect(() => {
    let active = true;
    setDestinationReady(false);
    const explicit = safeReturnPath(params.next);
    if (explicit !== "/") {
      setNext(explicit);
      void rememberAuthDestination(explicit).catch(() => undefined).finally(() => { if (active) setDestinationReady(true); });
    } else {
      void pendingAuthDestination().then(value => { if (active) setNext(value); }).finally(() => { if (active) setDestinationReady(true); });
    }
    return () => { active = false; };
  }, [params.next, session?.user.id]);
  function changeMode(value: Mode) { setMode(value); setError(""); setMessage(""); }
  async function googleSignIn() {
    if (!destinationReady || authAction.current) return;
    authAction.current = true;
    setGoogleLoading(true); setError("");
    try { if (await signInWithGoogle(next)) router.replace(safeReturnPath(next) as never); }
    catch (e) { setError(e instanceof Error ? e.message : "Google sign-in failed. Try again."); }
    finally { authAction.current = false; setGoogleLoading(false); }
  }
  async function resendConfirmation() {
    if (!destinationReady || authAction.current) return;
    if (!email.trim()) { setError("Enter your email address first."); return; }
    authAction.current = true;
    setLoading(true); setError(""); setMessage("");
    try {
      await rememberAuthDestination(next);
      const { error: resendError } = await supabase.auth.resend({ type: "signup", email: email.trim(), options: { emailRedirectTo: authRedirectUrl(next) } });
      if (resendError) throw resendError;
      setMessage("If this address needs confirmation, a new link is on its way. Check your inbox and spam folder.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not resend the link. Try again."); }
    finally { authAction.current = false; setLoading(false); }
  }
  async function submit() {
    if (!destinationReady || authAction.current) return;
    setError(""); setMessage("");
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError("Enter a valid email address."); return; }
    if (mode !== "recovery" && !password) { setError("Enter your password."); return; }
    if (mode === "signup" && password.length < 12) { setError("Use a password with at least 12 characters."); return; }
    authAction.current = true;
    setLoading(true);
    try {
      await rememberAuthDestination(next);
      if (mode === "recovery") {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: authRedirectUrl(next, "recovery") });
        if (resetError) throw resetError;
        setMessage("If an account exists for this address, a password reset link is on its way. Open it on this device/browser.");
      } else if (mode === "signup") {
        const { data, error: signupError } = await supabase.auth.signUp({email: email.trim(), password, options:{data:{full_name:fullName.trim()},emailRedirectTo:authRedirectUrl(next)}});
        if (signupError) throw signupError;
        if (data.session) { router.replace(safeReturnPath(next) as never); return; }
        setMessage("Check your inbox to confirm your email. Open the link on this device/browser to continue your invitation.");
        setMode("signin"); setPassword("");
      } else {
        const { error: signinError } = await supabase.auth.signInWithPassword({email:email.trim(),password});
        if (signinError) throw signinError;
        router.replace(safeReturnPath(next) as never);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not continue. Check your connection and try again."); }
    finally { authAction.current = false; setLoading(false); }
  }
  const busy = !destinationReady || loading || googleLoading;
  if (initializing || (session && !destinationReady)) return <Loading />;
  if (session) return <Redirect href={(next !== "/" ? next : role === "tenant" ? "/tenant" : "/(app)") as never} />;
  return <Screen><KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} className="flex-1"><ScrollView contentContainerClassName="flex-grow justify-center px-6 py-8" keyboardShouldPersistTaps="handled"><View className="mx-auto w-full max-w-lg">
    <Text className="text-3xl font-bold text-brand">RentView</Text><Text className="mb-6 mt-1 text-slate-500">Operations-first property management.</Text>
    {next.startsWith("/claim") ? <Text className="mb-4 text-slate-700">Sign in or create an account to join your landlord. Your invitation will be kept for the next step.</Text> : null}
    {mode !== "recovery" ? <><Button title={googleLoading ? "Connecting…" : "Continue with Google"} variant="secondary" onPress={googleSignIn} disabled={busy}/><Text className="my-4 text-center text-xs uppercase text-slate-400">or use email</Text></> : <Text className="mb-5 text-lg font-semibold text-slate-900">Reset your password</Text>}
    {mode === "signup" ? <Field label="Full name" value={fullName} onChangeText={setFullName} placeholder="Your name" autoComplete="name" maxLength={200}/> : null}
    <Field label="Email" value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" keyboardType="email-address" autoComplete="email" maxLength={254}/>
    {mode !== "recovery" ? <Field label={mode === "signup" ? "Password (at least 12 characters)" : "Password"} value={password} onChangeText={setPassword} secureTextEntry autoComplete={mode === "signup" ? "new-password" : "current-password"} onSubmitEditing={submit}/> : null}
    {error ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" className="mb-3 text-red-700">{error}</Text> : null}
    {message ? <Text accessibilityLiveRegion="polite" className="mb-3 text-teal-800">{message}</Text> : null}
    <Button title={mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"} onPress={submit} loading={loading} disabled={!destinationReady || googleLoading}/>
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => changeMode(mode === "signup" ? "signin" : "signup")} className="mt-5 py-2"><Text className="text-center text-brand">{mode === "signup" ? "Already have an account? Sign in" : "No account yet? Create one"}</Text></Pressable>
    {mode === "signin" ? <><Pressable accessibilityRole="button" disabled={busy} onPress={() => changeMode("recovery")} className="py-2"><Text className="text-center text-brand">Forgot password?</Text></Pressable><Pressable accessibilityRole="button" disabled={busy} onPress={resendConfirmation} className="py-2"><Text className="text-center text-brand">Resend confirmation email</Text></Pressable></> : mode === "recovery" ? <Button title="Back to sign in" variant="secondary" onPress={() => changeMode("signin")}/> : null}
    {next.startsWith("/claim")?<Pressable accessibilityRole="button" disabled={busy} onPress={()=>{void clearAuthDestination();setNext("/");router.replace("/(auth)/login");}} className="mt-3 py-2"><Text className="text-center text-brand">Manage properties instead</Text></Pressable>:null}
    <Pressable accessibilityRole="link" disabled={busy} onPress={() => router.push("/claim")} className="mt-5 py-3"><Text className="text-center font-semibold text-brand">I have an invite code</Text></Pressable>
  </View></ScrollView></KeyboardAvoidingView></Screen>;
}
