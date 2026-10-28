import { asObject, HttpError } from "./http.ts";

export type BillingStatus = "trialing" | "active" | "past_due" | "cancelled" | "expired";
export type BillingEvent = {
  provider: "lemonsqueezy" | "paypal";
  eventId: string;
  eventType: string;
  /** Customer-supplied hint, never authority for a new subscription binding. */
  ownerId: string | null;
  subscriptionId: string;
  customerId: string | null;
  plan: "free" | "pro";
  status: BillingStatus;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function text(value: unknown, maximum = 200): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum ? value.trim() : null;
}
function id(value: unknown): string | null { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : text(value); }
function time(value: unknown, required = false): string | null {
  const valueText = text(value, 64);
  if (!valueText && !required) return null;
  const parts = valueText?.match(/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/);
  const year = Number(parts?.[1]), month = Number(parts?.[2]), day = Number(parts?.[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!valueText || !parts || month < 1 || month > 12 || day < 1 || day > days[month - 1] || !Number.isFinite(Date.parse(valueText))) {
    throw new HttpError(400, "Missing or invalid event timestamp");
  }
  const normalized = new Date(valueText).toISOString();
  // Postgres retains microseconds. Do not collapse distinct provider updates to
  // the same millisecond and then incorrectly mark the newer update stale.
  const fraction = (parts[7] ?? "").padEnd(6, "0");
  return fraction.slice(3) === "000" ? normalized : normalized.replace(/\.\d{3}Z$/, `.${fraction}Z`);
}
function owner(value: unknown): string | null { const candidate = text(value, 36); return candidate && UUID.test(candidate) ? candidate : null; }

export async function verifyHmac(raw: string, signature: string, secret: string): Promise<boolean> {
  if (!/^[a-f\d]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = Uint8Array.from(signature.match(/.{2}/g)!, byte => parseInt(byte, 16));
  return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(raw));
}

const LEMON_STATUS: Record<string, { status: BillingStatus; plan: "free" | "pro" }> = {
  on_trial: { status: "trialing", plan: "pro" }, active: { status: "active", plan: "pro" },
  past_due: { status: "past_due", plan: "pro" }, cancelled: { status: "cancelled", plan: "pro" },
  paused: { status: "cancelled", plan: "free" }, unpaid: { status: "past_due", plan: "free" }, expired: { status: "expired", plan: "free" },
};
const LEMON_EVENTS = new Set(["subscription_created", "subscription_updated", "subscription_cancelled", "subscription_resumed", "subscription_expired", "subscription_paused", "subscription_unpaused"]);

export function lemonEvent(payload: Record<string, unknown>, config: { variantId: string; storeId: string; testMode: boolean }): BillingEvent | null {
  const meta = asObject(payload.meta), data = asObject(payload.data);
  const eventType = text(meta.event_name);
  if (!eventType || !LEMON_EVENTS.has(eventType)) return null;
  if (data.type !== "subscriptions") throw new HttpError(400, "Unexpected resource type");
  const attributes = asObject(data.attributes);
  if (String(attributes.variant_id) !== config.variantId || String(attributes.store_id) !== config.storeId || attributes.test_mode !== config.testMode) {
    throw new HttpError(400, "Subscription does not belong to this product or environment");
  }
  const status = String(attributes.status);
  const subscriptionId = id(data.id), mapped = Object.hasOwn(LEMON_STATUS, status) ? LEMON_STATUS[status] : undefined;
  if (!subscriptionId || !mapped) throw new HttpError(400, "Invalid subscription state");
  const occurredAt = time(attributes.updated_at, true)!;
  const custom = meta.custom_data ? asObject(meta.custom_data) : {};
  return {
    provider: "lemonsqueezy", eventId: `${eventType}:${subscriptionId}:${occurredAt}`, eventType,
    ownerId: owner(custom.user_id), subscriptionId, customerId: id(attributes.customer_id),
    ...mapped, periodEnd: time(attributes.ends_at) ?? time(attributes.renews_at),
    cancelAtPeriodEnd: attributes.cancelled === true || mapped.status === "cancelled", occurredAt, payload,
  };
}

const PAYPAL_EVENTS = new Set(["BILLING.SUBSCRIPTION.CREATED", "BILLING.SUBSCRIPTION.ACTIVATED", "BILLING.SUBSCRIPTION.UPDATED", "BILLING.SUBSCRIPTION.CANCELLED", "BILLING.SUBSCRIPTION.SUSPENDED", "BILLING.SUBSCRIPTION.EXPIRED", "BILLING.SUBSCRIPTION.RE-ACTIVATED"]);
const PAYPAL_STATUS: Record<string, { status: BillingStatus; plan: "free" | "pro" }> = {
  ACTIVE: { status: "active", plan: "pro" }, APPROVAL_PENDING: { status: "trialing", plan: "free" },
  APPROVED: { status: "trialing", plan: "free" }, SUSPENDED: { status: "past_due", plan: "free" },
  CANCELLED: { status: "cancelled", plan: "pro" }, EXPIRED: { status: "expired", plan: "free" },
};
export function paypalEvent(payload: Record<string, unknown>, planId: string): BillingEvent | null {
  const eventType = text(payload.event_type);
  if (!eventType || !PAYPAL_EVENTS.has(eventType)) return null;
  const resource = asObject(payload.resource);
  if (resource.plan_id !== planId) throw new HttpError(400, "Subscription does not belong to this product");
  const status = String(resource.status);
  const eventId = text(payload.id), subscriptionId = text(resource.id), mapped = Object.hasOwn(PAYPAL_STATUS, status) ? PAYPAL_STATUS[status] : undefined;
  if (!eventId || !subscriptionId || !mapped) throw new HttpError(400, "Invalid subscription event");
  const subscriber = resource.subscriber ? asObject(resource.subscriber) : {};
  const billing = resource.billing_info ? asObject(resource.billing_info) : {};
  return {
    provider: "paypal", eventId, eventType, ownerId: owner(resource.custom_id), subscriptionId,
    customerId: text(subscriber.payer_id), ...mapped,
    periodEnd: time(billing.next_billing_time), cancelAtPeriodEnd: mapped.status === "cancelled",
    occurredAt: time(resource.update_time ?? payload.create_time, true)!, payload,
  };
}

export function billingArguments(event: BillingEvent) {
  // Only an existing service-owned provider/subscription binding determines the
  // owner. The RPC may reject a conflicting hint, but must never use this hint
  // to initialize a new binding from hosted checkout metadata.
  return {
    p_provider: event.provider, p_event_id: event.eventId, p_event_type: event.eventType, p_owner_id: event.ownerId,
    p_subscription_id: event.subscriptionId, p_customer_id: event.customerId, p_plan: event.plan, p_status: event.status,
    p_period_end: event.periodEnd, p_cancel_at_period_end: event.cancelAtPeriodEnd, p_occurred_at: event.occurredAt, p_payload: event.payload,
  };
}
