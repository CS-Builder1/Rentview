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
import { supabase } from "./supabase";

export type UserRole = "owner" | "tenant";

type AuthContextValue = {
  session: Session | null;
  initializing: boolean;
  /** null while signed out or still loading. */
  role: UserRole | null;
  roleLoading: boolean;
  /** Re-fetch the profile role (e.g. right after claiming a tenant invite). */
  refreshRole: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [role, setRole] = useState<UserRole | null>(null);
  const [roleLoading, setRoleLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setInitializing(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id ?? null;

  const loadRole = useCallback(async (uid: string) => {
    // cachedSelect: fresh from the server when online, last-known-good when
    // offline — so app-open still routes to the right portal without a network.
    const rows = await cachedSelect<{ role: string }[]>(
      "profile.role",
      supabase.from("profiles").select("role").eq("id", uid),
    );
    const value = rows?.[0]?.role;
    return value === "tenant" ? "tenant" : "owner";
  }, []);

  useEffect(() => {
    let active = true;
    if (!userId) {
      setRole(null);
      setRoleLoading(false);
      return;
    }
    setRoleLoading(true);
    loadRole(userId).then((r) => {
      if (active) {
        setRole(r);
        setRoleLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [userId, loadRole]);

  const refreshRole = useCallback(async () => {
    if (!userId) return;
    setRole(await loadRole(userId));
  }, [userId, loadRole]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      initializing,
      role,
      roleLoading,
      refreshRole,
      signOut: async () => {
        await supabase.auth.signOut();
        await clearCache();
      },
    }),
    [session, initializing, role, roleLoading, refreshRole],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
