import { createClient, type Session } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/** A captured bearer token prevents delayed actions using a newer app session. */
export function createAccountSession(session: Session) {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Account service is unavailable in this build.");
  if (!session.access_token || !session.refresh_token || !session.user.id) {
    throw new Error("Your session is unavailable. Sign in again before changing account settings.");
  }
  if (session.expires_at && session.expires_at * 1000 <= Date.now()) {
    throw new Error("Your session expired. Wait for it to refresh or sign in again, then retry.");
  }
  const accessToken = session.access_token;
  const accountId = session.user.id;
  const origin = new URL(url).origin;
  return createClient<Database>(url, key, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
      fetch: (input, init) => {
        const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (target.origin !== origin) throw new Error("Account actions can only contact the configured account service.");
        let path = target.pathname;
        for (let i = 0; i < 4; i++) {
          const decoded = decodeURIComponent(path);
          if (decoded === path) break;
          path = decoded;
        }
        const segments: string[] = [];
        for (const segment of path.replace(/\\/g, "/").split("/")) {
          if (!segment || segment === ".") continue;
          if (segment === "..") segments.pop();
          else segments.push(segment.toLowerCase());
        }
        if (`/${segments.join("/")}`.endsWith("/auth/v1/token")) {
          // autoRefreshToken:false disables the timer, but SDK setSession and
          // getSession may still refresh opportunistically. A temporary client
          // must never consume or rotate the shared app's refresh token.
          return Promise.resolve(new Response(JSON.stringify({
            message: "This account action needs a fresh session. Retry after the app refreshes.",
            code: "account_snapshot_expired",
          }), { status: 401, headers: { "Content-Type": "application/json" } }));
        }
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
        headers.set("Authorization", `Bearer ${accessToken}`);
        return fetch(input, { ...init, headers });
      },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
      storageKey: `rentview.account-action.${accountId}`,
    },
  });
}
