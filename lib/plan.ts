import { useCallback, useEffect, useState } from "react";

import { useAuth } from "./auth";
import { cachedSelect } from "./cache";
import type { Tables } from "./database.types";
import { supabase } from "./supabase";

/**
 * How many properties the Free tier allows.
 *
 * BUSINESS DECISION — this is the only number that separates Free from Pro
 * today. Change it here and the whole app follows. Everything else (units,
 * work orders, assets, inventory, documents, offline capture) is unlimited on
 * Free, which is what "a generous free tier" is meant to mean.
 */
export const FREE_PROPERTY_LIMIT = 3;

export type PlanState = {
  /** True when the account may use Pro-only capacity right now. */
  isPro: boolean;
  subscription: Tables<"subscriptions"> | null;
  /** Null while Pro — there is no cap to show. */
  propertyLimit: number | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

/**
 * A subscription grants Pro while it is paid for. A cancelled subscription
 * keeps it until the period the customer already paid for runs out — cutting
 * access at the moment someone cancels would be taking money for nothing.
 */
export function grantsPro(sub: Tables<"subscriptions"> | null): boolean {
  if (!sub || sub.plan !== "pro") return false;
  if (sub.status === "active" || sub.status === "trialing" || sub.status === "past_due") {
    return true;
  }
  if (sub.status === "cancelled") {
    return sub.current_period_end
      ? new Date(sub.current_period_end).getTime() > Date.now()
      : false;
  }
  return false;
}

/**
 * The account's current entitlement. Cached like every other read, so the app
 * does not silently downgrade someone to Free just because they are offline.
 */
export function usePlan(): PlanState {
  const { session } = useAuth();
  const [subscription, setSubscription] = useState<Tables<"subscriptions"> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const userId = session?.user.id ?? null;

  const refresh = useCallback(async () => {
    if (!userId) {
      setSubscription(null);
      setLoading(false);
      return;
    }
    const data = await cachedSelect<Tables<"subscriptions"> | null>(
      `subscription:${userId}`,
      supabase
        .from("subscriptions")
        .select("*")
        .eq("owner_id", userId)
        .maybeSingle(),
    );
    setSubscription(data ?? null);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const isPro = grantsPro(subscription);
  return {
    isPro,
    subscription,
    propertyLimit: isPro ? null : FREE_PROPERTY_LIMIT,
    loading,
    refresh,
  };
}

/**
 * Add the account id (and email) to a Lemon Squeezy checkout link so the
 * webhook can match the payment to this user. Lemon Squeezy returns these as
 * `meta.custom_data` on every subscription event.
 */
export function lemonSqueezyCheckoutUrl(
  base: string,
  userId: string,
  email?: string | null,
): string {
  try {
    const url = new URL(base);
    url.searchParams.set("checkout[custom][user_id]", userId);
    if (email) url.searchParams.set("checkout[email]", email);
    return url.toString();
  } catch {
    return base;
  }
}
