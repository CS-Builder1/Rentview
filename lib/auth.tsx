import type { Session } from "@supabase/supabase-js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { cachedSelect, clearCache } from "./cache";
import { unregisterPushToken } from "./push";
import { supabase } from "./supabase";

export type Role = "owner" | "tenant";

type AuthContextValue = {
  session: Session | null;
  /** True until BOTH the session and the profile role are known. */
  initializing: boolean;
  /** Which app to show. Null only while signed out. */
  role: Role | null;
  /**
   * Re-read the profile and return the role it resolved to — call after
   * claiming a tenant invite, when the caller must route on the new role
   * before context has re-rendered.
   */
  refreshProfile: () => Promise<Role | null>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [role, setRole] = useState<Role | null>(null);
  const [roleLoading, setRoleLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const uid = session?.user.id ?? null;

  // The role decides which app renders, so it is cached alongside the other
  // reads — a tenant opening the app offline still lands in the tenant portal.
  const loadRole = useCallback(async (userId: string): Promise<Role> => {
    const data = await cachedSelect<{ role: string } | null>(
      `profile:${userId}`,
      supabase.from("profiles").select("role").eq("id", userId).maybeSingle(),
    );
    const next: Role = data?.role === "tenant" ? "tenant" : "owner";
    setRole(next);
    return next;
  }, []);

  useEffect(() => {
    if (!uid) {
      setRole(null);
      setRoleLoading(false);
      return;
    }
    let cancelled = false;
    setRoleLoading(true);
    loadRole(uid).finally(() => {
      if (!cancelled) setRoleLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [uid, loadRole]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      initializing: sessionLoading || roleLoading,
      role,
      refreshProfile: async () => (uid ? loadRole(uid) : null),
      signOut: async () => {
        // Best effort: never block sign-out on the notification service.
        await unregisterPushToken().catch(() => undefined);
        await supabase.auth.signOut();
        await clearCache();
        setRole(null);
      },
    }),
    [session, sessionLoading, roleLoading, role, uid, loadRole],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
