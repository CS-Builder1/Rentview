import type { Session } from "@supabase/supabase-js";
import { usePathname, useRouter } from "expo-router";
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { cachedSelectResult, clearCache, setCacheAccount } from "./cache";
import { clearAuthDestination } from "./authDestination";
import { unregisterPushToken } from "./push";
import { completeDeviceSignOut } from "./sessionActions";
import { supabase } from "./supabase";

export type Role = "owner" | "tenant";

type AuthContextValue = {
  session: Session | null;
  initializing: boolean;
  role: Role | null;
  profileError: string | null;
  refreshProfile: () => Promise<Role | null>;
  signOut: () => Promise<void>;
  finishAccountDeletion: (expectedUserId: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [role, setRole] = useState<Role | null>(null);
  const [roleUserId, setRoleUserId] = useState<string | null>(null);
  const [roleLoading, setRoleLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const activeUser = useRef<string | null>(null);
  const profileRequest = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let live = true;
    let authRevision = 0;
    const accept = (next: Session | null) => {
      if (!live || !mounted.current) return;
      const nextUid = next?.user.id ?? null;
      setCacheAccount(nextUid);
      if (activeUser.current !== nextUid) {
        profileRequest.current += 1;
        activeUser.current = nextUid;
        // Set the namespace before any route can start a query for this session.
        setRole(null);
        setRoleUserId(null);
        setProfileError(null);
      }
      setSession(next);
      setSessionLoading(false);
    };
    const startedAt = authRevision;
    supabase.auth.getSession().then(({ data, error }) => {
      if (authRevision === startedAt) accept(error ? null : data.session);
    }).catch(() => { if (authRevision === startedAt) accept(null); });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      authRevision += 1;
      accept(next);
    });
    return () => {
      live = false;
      mounted.current = false;
      profileRequest.current += 1;
      setCacheAccount(null);
      subscription.subscription.unsubscribe();
    };
  }, []);

  const uid = session?.user.id ?? null;
  const loadRole = useCallback(async (userId: string): Promise<Role | null> => {
    const request = ++profileRequest.current;
    setRoleLoading(true);
    const result = await cachedSelectResult<{ role: string } | null>(
      `profile:${userId}`,
      supabase.from("profiles").select("role").eq("id", userId).maybeSingle(),
    );
    if (!mounted.current || activeUser.current !== userId || request !== profileRequest.current) return null;
    const next = result.data?.role;
    if (next !== "owner" && next !== "tenant") {
      setRole(null);
      setRoleUserId(null);
      setProfileError(result.error ?? "Your account profile is unavailable. Retry to continue.");
      setRoleLoading(false);
      return null;
    }
    setRole(next);
    setRoleUserId(userId);
    setProfileError(null);
    setRoleLoading(false);
    return next;
  }, []);

  useEffect(() => {
    if (!uid) {
      setRole(null);
      setRoleUserId(null);
      setRoleLoading(false);
      return;
    }
    void loadRole(uid);
  }, [uid, loadRole]);

  const performSignOut = useCallback(async (expectedUserId?: string) => {
    const signingOutUser = activeUser.current;
    setSigningOut(true);
    try {
      await completeDeviceSignOut({
        account: () => activeUser.current,
        unregisterDevice: unregisterPushToken,
        // Local scope signs out this device without terminating other sessions.
        signOutSession: () => supabase.auth.signOut({ scope: "local" }),
        acceptSignedOut: () => {
          activeUser.current = null;
          profileRequest.current += 1;
          setCacheAccount(null);
          setSession(null);
          setRole(null);
          setRoleUserId(null);
        },
        clearReadCache: clearCache,
        clearDestination: clearAuthDestination,
      }, expectedUserId);
    } catch (error) {
      const message = "Sign-out could not finish. Check your connection, then try again. Your saved changes remain on this device.";
      if (mounted.current && activeUser.current === signingOutUser) setProfileError(message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      if (mounted.current) setSigningOut(false);
    }
  }, []);
  const signOut = useCallback(() => performSignOut(), [performSignOut]);
  const finishAccountDeletion = useCallback((expectedUserId: string) => performSignOut(expectedUserId), [performSignOut]);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    // A role from a previous account must never authorize a newly signed-in account.
    initializing: sessionLoading || signingOut || roleLoading || Boolean(uid && roleUserId !== uid && !profileError),
    role: roleUserId === uid ? role : null,
    profileError,
    refreshProfile: () => uid ? loadRole(uid) : Promise.resolve(null),
    signOut,
    finishAccountDeletion,
  }), [session, sessionLoading, signingOut, roleLoading, uid, roleUserId, profileError, role, loadRole, signOut, finishAccountDeletion]);
  const needsProfileRecovery = Boolean(session && profileError && !roleLoading && pathname !== "/account");

  return (
    <AuthContext.Provider value={value}>
      <View className="flex-1">
        {/* Keep the root navigator mounted so recovery navigation works even
            when deletion intentionally makes the profile unreadable. Hiding,
            rather than overlaying it, also removes underlying focus targets. */}
        <View style={{ flex: 1, display: needsProfileRecovery ? "none" : "flex" }}>{children}</View>
      {needsProfileRecovery && session ? (
        <View className="flex-1 items-center justify-center bg-slate-50 px-8">
          <Text className="mb-3 text-center text-xl font-semibold text-slate-900">Account needs attention</Text>
          <Text accessibilityRole="alert" className="mb-5 text-center text-slate-600">{profileError}</Text>
          <Pressable accessibilityRole="button" onPress={() => void loadRole(session.user.id)} className="mb-4 rounded-xl bg-teal-700 px-6 py-3">
            <Text className="font-semibold text-white">Retry</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => router.push("/account")} className="mb-4 rounded-xl bg-teal-700 px-6 py-3">
            <Text className="font-semibold text-white">Account recovery / continue deletion</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => void signOut().catch(() => undefined)} disabled={signingOut} className="px-6 py-3">
            {signingOut ? <ActivityIndicator /> : <Text className="text-teal-700">Sign out</Text>}
          </Pressable>
        </View>
      ) : null}
      </View>
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
