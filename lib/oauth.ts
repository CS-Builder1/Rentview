import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";

import { rememberAuthDestination } from "./authDestination";
import { callbackParams, safeReturnPath } from "./invites";
import { supabase } from "./supabase";

WebBrowser.maybeCompleteAuthSession();

/** Allow-list /callback (web) and rentview://callback (native) in Supabase Auth. */
export function authRedirectUrl(next = "/", intent?: "recovery"): string {
  const base = Platform.OS === "web" ? `${window.location.origin}/callback` : Linking.createURL("callback");
  const url = new URL(base);
  url.searchParams.set("next", safeReturnPath(next));
  if (intent) url.searchParams.set("intent", intent);
  return url.toString();
}

const exchanges = new Map<string, Promise<void>>();
export function exchangeAuthCodeOnce(code: string): Promise<void> {
  const existing = exchanges.get(code);
  if (existing) return existing;
  const promise = (async () => {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
  })();
  if (exchanges.size >= 20) exchanges.delete(exchanges.keys().next().value!);
  exchanges.set(code, promise);
  // Failure can be retried; successful exchanges remain deduplicated in this process.
  void promise.catch(() => exchanges.delete(code));
  return promise;
}

export async function signInWithGoogle(next = "/"): Promise<boolean> {
  const safe = safeReturnPath(next);
  await rememberAuthDestination(safe);
  const redirectTo = authRedirectUrl(safe);
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo, skipBrowserRedirect: Platform.OS !== "web" },
  });
  if (error) throw error;
  if (Platform.OS === "web") return false;
  if (!data?.url) throw new Error("Could not start Google sign-in.");
  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== "success" || !result.url) return false;
  const parsed = callbackParams(result.url);
  if (parsed.error) throw new Error(parsed.error);
  if (!parsed.code) throw new Error("The sign-in link did not include a confirmation code. Try signing in again.");
  await exchangeAuthCodeOnce(parsed.code);
  return true;
}
