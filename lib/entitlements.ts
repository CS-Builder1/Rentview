export type SubscriptionEntitlement = {
  plan: string;
  status: string;
  billing_verified_at: string | null;
  current_period_end: string | null;
};
/** Paid access only follows a provider-verified, service-written subscription. */
export function grantsPro(sub: SubscriptionEntitlement | null, now = Date.now()): boolean {
  if (!sub || sub.plan !== "pro" || !sub.billing_verified_at || !Number.isFinite(Date.parse(sub.billing_verified_at))) return false;
  if (["active", "trialing", "past_due"].includes(sub.status)) return true;
  return sub.status === "cancelled" && !!sub.current_period_end && Date.parse(sub.current_period_end) > now;
}
