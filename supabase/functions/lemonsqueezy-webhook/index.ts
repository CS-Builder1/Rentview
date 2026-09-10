// Lemon Squeezy subscription webhook.
//
// Lemon Squeezy is the merchant of record, so this function never sees card
// data — it only mirrors subscription state into `subscriptions` so the app
// knows what the account is entitled to.
//
// Every request is authenticated by an HMAC-SHA256 of the RAW body keyed with
// LEMONSQUEEZY_WEBHOOK_SECRET, compared against the X-Signature header in
// constant time. Unverified requests are rejected before anything is read.
//
// The account is resolved from `meta.custom_data.user_id`, which the app puts
// on the checkout URL (`?checkout[custom][user_id]=<uid>`), falling back to
// matching the buyer's email when a checkout was started outside the app.
//
// Secrets: LEMONSQUEEZY_WEBHOOK_SECRET.

import { createClient } from "jsr:@supabase/supabase-js@2";

type SubStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "cancelled"
  | "expired";

// Lemon Squeezy status -> our status, and whether it still grants Pro.
// `cancelled` keeps Pro because the subscription runs to the end of the paid
// period; `expired` is when it has actually lapsed.
const STATUS: Record<string, { status: SubStatus; pro: boolean }> = {
  on_trial: { status: "trialing", pro: true },
  active: { status: "active", pro: true },
  past_due: { status: "past_due", pro: true },
  cancelled: { status: "cancelled", pro: true },
  paused: { status: "cancelled", pro: false },
  unpaid: { status: "past_due", pro: false },
  expired: { status: "expired", pro: false },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signatureFor(raw: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("LEMONSQUEEZY_WEBHOOK_SECRET");
  if (!secret) return json({ error: "Webhook secret is not configured" }, 503);

  const raw = await req.text();
  const provided = req.headers.get("X-Signature") ?? "";
  const expected = await signatureFor(raw, secret);
  if (!constantTimeEqual(expected, provided)) {
    return json({ error: "Bad signature" }, 401);
  }

  let event: {
    meta?: { event_name?: string; custom_data?: Record<string, unknown> };
    data?: {
      id?: string;
      attributes?: Record<string, unknown>;
    };
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "Malformed body" }, 400);
  }

  const eventName = event.meta?.event_name ?? "";
  if (!eventName.startsWith("subscription_")) {
    // Orders, licences and the rest are not what this function tracks.
    return json({ ignored: eventName });
  }

  const attributes = event.data?.attributes ?? {};
  const subscriptionId = event.data?.id ? String(event.data.id) : null;
  const lsStatus = String(attributes.status ?? "");
  const mapped = STATUS[lsStatus];
  if (!mapped) return json({ ignored: `unknown status ${lsStatus}` });

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey);

  // Resolve the account: custom data first, then the buyer's email.
  const customUserId = event.meta?.custom_data?.user_id;
  let ownerId = typeof customUserId === "string" ? customUserId : null;
  if (!ownerId && typeof attributes.user_email === "string") {
    const { data } = await admin.rpc("user_id_for_email", {
      p_email: attributes.user_email,
    });
    ownerId = typeof data === "string" ? data : null;
  }

  // Retries repeat the same state, so dedupe on it rather than on delivery.
  const eventId = [eventName, subscriptionId, attributes.updated_at ?? ""].join(":");
  const { error: eventError } = await admin.from("billing_events").insert({
    provider: "lemonsqueezy",
    event_id: eventId,
    event_type: eventName,
    owner_id: ownerId,
    payload: event as unknown as Record<string, unknown>,
  });
  if (eventError) {
    // Unique violation = we have already applied this exact state.
    if (eventError.code === "23505") return json({ duplicate: true });
    return json({ error: eventError.message }, 500);
  }

  if (!ownerId) {
    // Recorded for investigation, but there is no account to apply it to.
    return json({ error: "Could not match this subscription to an account" }, 202);
  }

  const endsAt = attributes.ends_at;
  const renewsAt = attributes.renews_at;
  const { error } = await admin.from("subscriptions").upsert(
    {
      owner_id: ownerId,
      provider: "lemonsqueezy",
      provider_subscription_id: subscriptionId,
      provider_customer_id:
        attributes.customer_id != null ? String(attributes.customer_id) : null,
      plan: mapped.pro ? "pro" : "free",
      status: mapped.status,
      current_period_end:
        (typeof endsAt === "string" ? endsAt : null) ??
        (typeof renewsAt === "string" ? renewsAt : null),
      cancel_at_period_end: attributes.cancelled === true,
    },
    { onConflict: "owner_id" },
  );
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, owner: ownerId, status: mapped.status });
});
