// PayPal subscription webhook.
//
// Every request is verified with PayPal's own verify-webhook-signature API
// before anything is read: we hand back the transmission headers and the raw
// event, and PayPal tells us whether it really sent it. A request PayPal does
// not vouch for is rejected.
//
// Account matching is the awkward part. Lemon Squeezy carries our user id
// through checkout custom data; PayPal's hosted subscribe link has no
// documented way to do that, so this falls back to the payer's email. If a
// tenant pays with a different PayPal email than their RentView login, the
// event is recorded in billing_events but no subscription is applied — check
// there when someone says they paid and the app disagrees. Subscriptions
// created through PayPal's API with a `custom_id` are matched exactly.
//
// Secrets: PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_WEBHOOK_ID,
//          PAYPAL_ENV ("live" or "sandbox", default "live").

import { createClient } from "jsr:@supabase/supabase-js@2";

type SubStatus = "trialing" | "active" | "past_due" | "cancelled" | "expired";

// PayPal subscription status -> our status, and whether it still grants Pro.
const STATUS: Record<string, { status: SubStatus; pro: boolean }> = {
  ACTIVE: { status: "active", pro: true },
  APPROVAL_PENDING: { status: "trialing", pro: false },
  APPROVED: { status: "trialing", pro: false },
  SUSPENDED: { status: "past_due", pro: false },
  CANCELLED: { status: "cancelled", pro: true },
  EXPIRED: { status: "expired", pro: false },
};

const TRACKED = new Set([
  "BILLING.SUBSCRIPTION.CREATED",
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.UPDATED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.EXPIRED",
  "BILLING.SUBSCRIPTION.RE-ACTIVATED",
]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function apiBase(): string {
  return Deno.env.get("PAYPAL_ENV") === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";
}

async function accessToken(): Promise<string | null> {
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
  const secret = Deno.env.get("PAYPAL_SECRET");
  if (!clientId || !secret) return null;

  const response = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { access_token?: string };
  return data.access_token ?? null;
}

/** Ask PayPal whether it really sent this delivery. */
async function verifiedByPayPal(
  req: Request,
  rawEvent: unknown,
  token: string,
): Promise<boolean> {
  const webhookId = Deno.env.get("PAYPAL_WEBHOOK_ID");
  if (!webhookId) return false;

  const response = await fetch(
    `${apiBase()}/v1/notifications/verify-webhook-signature`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        auth_algo: req.headers.get("paypal-auth-algo"),
        cert_url: req.headers.get("paypal-cert-url"),
        transmission_id: req.headers.get("paypal-transmission-id"),
        transmission_sig: req.headers.get("paypal-transmission-sig"),
        transmission_time: req.headers.get("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: rawEvent,
      }),
    },
  );
  if (!response.ok) return false;
  const result = (await response.json()) as { verification_status?: string };
  return result.verification_status === "SUCCESS";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const raw = await req.text();
  let event: {
    id?: string;
    event_type?: string;
    resource?: {
      id?: string;
      status?: string;
      custom_id?: string;
      subscriber?: { email_address?: string; payer_id?: string };
      billing_info?: { next_billing_time?: string };
    };
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "Malformed body" }, 400);
  }

  const token = await accessToken();
  if (!token) return json({ error: "PayPal credentials are not configured" }, 503);
  if (!(await verifiedByPayPal(req, JSON.parse(raw), token))) {
    return json({ error: "PayPal did not verify this delivery" }, 401);
  }

  const eventType = event.event_type ?? "";
  if (!TRACKED.has(eventType)) return json({ ignored: eventType });

  const resource = event.resource ?? {};
  const mapped = STATUS[String(resource.status ?? "")];
  if (!mapped) return json({ ignored: `unknown status ${resource.status}` });

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey);

  let ownerId = resource.custom_id ?? null;
  if (!ownerId && resource.subscriber?.email_address) {
    const { data } = await admin.rpc("user_id_for_email", {
      p_email: resource.subscriber.email_address,
    });
    ownerId = typeof data === "string" ? data : null;
  }

  const { error: eventError } = await admin.from("billing_events").insert({
    provider: "paypal",
    event_id: event.id ?? `${eventType}:${resource.id}:${resource.status}`,
    event_type: eventType,
    owner_id: ownerId,
    payload: event as unknown as Record<string, unknown>,
  });
  if (eventError) {
    if (eventError.code === "23505") return json({ duplicate: true });
    return json({ error: eventError.message }, 500);
  }

  if (!ownerId) {
    return json({ error: "Could not match this subscription to an account" }, 202);
  }

  const { error } = await admin.from("subscriptions").upsert(
    {
      owner_id: ownerId,
      provider: "paypal",
      provider_subscription_id: resource.id ?? null,
      provider_customer_id: resource.subscriber?.payer_id ?? null,
      plan: mapped.pro ? "pro" : "free",
      status: mapped.status,
      current_period_end: resource.billing_info?.next_billing_time ?? null,
      cancel_at_period_end: mapped.status === "cancelled",
    },
    { onConflict: "owner_id" },
  );
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, owner: ownerId, status: mapped.status });
});
