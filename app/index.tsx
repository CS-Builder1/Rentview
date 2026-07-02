import { Redirect } from "expo-router";
import { useEffect, useState } from "react";

import { Loading } from "../components/ui";
import { useToast } from "../components/Toast";
import { useAuth } from "../lib/auth";
import {
  claimInvite,
  clearPendingInviteCode,
  getPendingInviteCode,
} from "../lib/invites";

export default function Index() {
  const { session, initializing, role, roleLoading, refreshRole } = useAuth();
  const [claiming, setClaiming] = useState(false);
  const [claimChecked, setClaimChecked] = useState(false);
  const toast = useToast();

  const userId = session?.user.id ?? null;

  // If the user signed up with a tenant invite code, claim it before routing
  // so their role is already "tenant" on first render of the portal.
  useEffect(() => {
    let active = true;
    if (!userId) {
      setClaimChecked(false);
      return;
    }
    (async () => {
      const code = await getPendingInviteCode();
      if (!code) {
        if (active) setClaimChecked(true);
        return;
      }
      setClaiming(true);
      try {
        await claimInvite(code);
        await clearPendingInviteCode();
        await refreshRole();
        toast.show("Welcome! Your home is connected.");
      } catch (e) {
        await clearPendingInviteCode();
        toast.show(
          e instanceof Error ? e.message : "Could not claim the invite code",
          "error",
        );
      } finally {
        if (active) {
          setClaiming(false);
          setClaimChecked(true);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [userId, refreshRole, toast]);

  if (initializing) return <Loading />;
  if (!session) return <Redirect href="/(auth)/login" />;
  if (roleLoading || claiming || !claimChecked) return <Loading />;
  if (role === "tenant") return <Redirect href="/(tenant)" />;
  return <Redirect href="/(app)" />;
}
