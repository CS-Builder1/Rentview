import { useCallback, useEffect, useRef, useState } from "react";

import { useAuth } from "./auth";
import { createAccountSession } from "./accountSession";
import { cachedSelectResult } from "./cache";
import type { Tables } from "./database.types";
import { grantsPro } from "./entitlements";

/**
 * How many properties the Free tier allows.
 *
 * BUSINESS DECISION — this is the only number that separates Free from Pro
 * today. This UI value must match the database capacity guard; changing the
 * limit requires an explicit reviewed migration and a UI update. Everything else (units,
 * work orders, assets, inventory, documents, offline capture) is unlimited on
 * Free, which is what "a generous free tier" is meant to mean.
 */
export const FREE_PROPERTY_LIMIT = 3;

export type PlanState = {
  /** True when the account may use Pro-only capacity right now. */
  isPro: boolean;
  subscription: Tables<"subscriptions"> | null;
  /** Null for Pro or an unknown plan; the database always enforces capacity. */
  propertyLimit: number | null;
  known: boolean;
  reconciliationPending: boolean | null;
  error: string | null;
  stale: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
};

/**
 * A subscription grants Pro while it is paid for. A cancelled subscription
 * keeps it until the period the customer already paid for runs out — cutting
 * access at the moment someone cancels would be taking money for nothing.
 */
export { grantsPro } from "./entitlements";

/**
 * The account's current entitlement. Cached like every other read, so the app
 * does not silently downgrade someone to Free just because they are offline.
 */
export function usePlan(): PlanState {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const currentUser = useRef(userId);
  currentUser.current = userId;
  const revision = useRef(0);
  const mounted = useRef(false);
  const [state, setState] = useState<{
    accountId: string | null;
    subscription: Tables<"subscriptions"> | null;
    known: boolean;
    reconciliationPending: boolean | null;
    error: string | null;
    stale: boolean;
    loading: boolean;
  }>({ accountId: null, subscription: null, known: false, reconciliationPending: null, error: null, stale: false, loading: true });

  const refresh = useCallback(async () => {
    const snapshot = session;
    const accountId = snapshot?.user.id ?? null;
    const request = ++revision.current;
    const current = () => mounted.current && request === revision.current && currentUser.current === accountId;
    if (!snapshot || !accountId) {
      if (current()) setState({ accountId: null, subscription: null, known: false, reconciliationPending: null, error: null, stale: false, loading: false });
      return;
    }
    setState(previous => previous.accountId === accountId
      ? { ...previous, loading: true, error: null }
      : { accountId, subscription: null, known: false, reconciliationPending: null, error: null, stale: false, loading: true });
    try {
      // Both reads retain the initiating bearer token even if another tab signs
      // into a different account while their requests are waiting.
      const client = createAccountSession(snapshot);
      const [plan, review] = await Promise.all([
        cachedSelectResult<Tables<"subscriptions"> | null>(`subscription:${accountId}`,
          client.from("subscriptions").select("*").eq("owner_id", accountId).maybeSingle()),
        cachedSelectResult<boolean>(`billing-reconciliation:${accountId}`, client.rpc("billing_reconciliation_pending")),
      ]);
      if (!current()) return;
      const reviewKnown = typeof review.data === "boolean";
      const errors = [
        plan.error ? "Your plan could not be refreshed. Saved information is shown when available." : null,
        review.error || !reviewKnown ? "Billing review status is unavailable. Please retry." : null,
      ].filter(Boolean);
      setState({ accountId, subscription: plan.data, known: plan.source !== "none",
        reconciliationPending: typeof review.data === "boolean" ? review.data : null,
        error: errors.length ? errors.join(" ") : null,
        stale: plan.stale || review.stale, loading: false });
    } catch {
      if (!current()) return;
      setState(previous => ({ ...previous, loading: false, stale: previous.known,
        error: "Billing information is unavailable. Refresh your session and retry." }));
    }
  }, [session]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; revision.current++; };
  }, [refresh]);

  // Hide the previous account's state during the render before effects reset it.
  const belongsToCurrentUser = !!userId && state.accountId === userId;
  const subscription = belongsToCurrentUser ? state.subscription : null;
  const known = belongsToCurrentUser && state.known;
  const isPro = grantsPro(subscription);
  return {
    isPro, subscription, known,
    propertyLimit: known && !isPro ? FREE_PROPERTY_LIMIT : null,
    reconciliationPending: belongsToCurrentUser ? state.reconciliationPending : null,
    error: belongsToCurrentUser ? state.error : null,
    stale: belongsToCurrentUser && state.stale,
    loading: !belongsToCurrentUser || state.loading,
    refresh,
  };
}

/**
 * Append customer-controlled convenience hints to a Lemon Squeezy link. These
 * values never authorize a billing binding; the backend requires independent
 * service-owned account provenance. Paid checkout remains disabled.
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
