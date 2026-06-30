import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";

import { supabase } from "./supabase";

// Required on native so the auth popup can hand control back to the app.
WebBrowser.maybeCompleteAuthSession();

/**
 * The URL Supabase should redirect back to after email confirmation / OAuth.
 * On web this is the current origin; on native it's the app's deep link.
 * NOTE: this exact URL (or a wildcard covering it) must be in Supabase's
 * Authentication → URL Configuration → Redirect URLs allow-list.
 */
export function authRedirectUrl(): string {
  if (Platform.OS === "web") return window.location.origin;
  return Linking.createURL("/");
}

/** One-click Google sign-in. Web redirects the page; native uses an auth session. */
export async function signInWithGoogle(): Promise<void> {
  const redirectTo = authRedirectUrl();

  if (Platform.OS === "web") {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) throw error;
    return; // browser navigates to Google, then back to redirectTo
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data?.url) throw new Error("Could not start Google sign-in.");

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== "success" || !result.url) return;

  const { queryParams } = Linking.parse(result.url);
  const code = queryParams?.code;
  if (typeof code === "string") {
    const { error: exchangeError } =
      await supabase.auth.exchangeCodeForSession(code);
    if (exchangeError) throw exchangeError;
  }
}
