// Push notifications for tenant-portal activity, delivered via Expo's push
// service (https://exp.host/--/api/v2/push/send).
//
// CALLED BY THE DATABASE, not by the app. Triggers on maintenance_requests,
// request_messages and announcements queue the call through pg_net inside the
// writing transaction, so a notification can never be skipped by a client that
// died mid-action, and never fires for a write that rolled back.
//
// Auth is the shared secret in `x-push-secret` (env PUSH_HOOK_SECRET, matched
// against the Vault copy the triggers read). JWT verification is off because
// Postgres has no session to present — the secret IS the authentication, so
// the function refuses every request without it.
//
// Body: { event, id, actor, preview? }
//   request_created  — tenant filed a request        -> notify the owner
//   request_updated  — status changed                -> notify the other party
//   request_message  — someone posted on the thread  -> notify the other party
//   announcement     — owner posted a notice         -> notify its tenants
//
// `actor` is whoever caused the write; the recipient is derived as the other
// participant, so nobody is ever notified about their own action.

import { createClient } from "jsr:@supabase/supabase-js@2";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const CHUNK = 100;

type Event =
  | "request_created"
  | "request_updated"
  | "request_message"
  | "announcement";

/** Which notification_prefs column decides whether an event may be sent. */
const PREF_COLUMN: Record<Event, "requests" | "messages" | "announcements"> = {
  request_created: "requests",
  request_updated: "requests",
  request_message: "messages",
  announcement: "announcements",
};

type Recipient = { userId: string; url: string };

type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  sound: "default";
  channelId: "default";
  data: Record<string, string>;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clamp(value: string, max = 140): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

Deno.serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const hookSecret = Deno.env.get("PUSH_HOOK_SECRET");

  // No secret configured means push was never set up on this project. Fail
  // closed rather than accepting anonymous calls.
  if (!hookSecret) {
    return json({ error: "PUSH_HOOK_SECRET is not set" }, 503);
  }
  if (req.headers.get("x-push-secret") !== hookSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  let payload: { event?: Event; id?: string; actor?: string; preview?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Expected a JSON body" }, 400);
  }
  const { event, id, actor, preview } = payload;
  if (!event || !id) return json({ error: "Missing event or id" }, 400);

  const admin = createClient(url, serviceKey);

  let recipients: Recipient[] = [];
  let title = "RentView";
  let body = "";
  let data: Record<string, string> = {};

  if (
    event === "request_created" ||
    event === "request_updated" ||
    event === "request_message"
  ) {
    const { data: request, error } = await admin
      .from("maintenance_requests")
      .select(
        "id, title, status, owner_id, tenant_user_id, units(label), properties(name)",
      )
      .eq("id", id)
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!request) return json({ error: "Request not found" }, 404);

    const actorIsOwner = request.owner_id === actor;
    const actorIsTenant = request.tenant_user_id === actor;
    if (!actorIsOwner && !actorIsTenant) {
      return json({ sent: 0, recipients: 0, reason: "actor not a participant" });
    }

    const recipientId = actorIsOwner ? request.tenant_user_id : request.owner_id;
    const recipientIsOwner = !actorIsOwner;
    if (!recipientId) return json({ sent: 0, recipients: 0 });

    const unit = (request.units as { label: string } | null)?.label;
    const property = (request.properties as { name: string } | null)?.name;
    const place = [property, unit].filter(Boolean).join(" · ");

    if (event === "request_created") {
      title = "New repair request";
      body = clamp(place ? `${place}: ${request.title}` : request.title);
    } else if (event === "request_updated") {
      title = "Request updated";
      body = clamp(
        `${request.title} — ${String(request.status).replace(/_/g, " ")}`,
      );
    } else {
      title = "New message";
      body = clamp(preview ? preview : `About: ${request.title}`);
    }

    recipients = [
      {
        userId: recipientId,
        url: recipientIsOwner
          ? `/request/${request.id}`
          : `/tenant/request/${request.id}`,
      },
    ];
    data = { url: recipients[0].url, requestId: String(request.id) };
  } else if (event === "announcement") {
    const { data: announcement, error } = await admin
      .from("announcements")
      .select("id, title, body, owner_id, property_id")
      .eq("id", id)
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!announcement) return json({ error: "Announcement not found" }, 404);

    // Every tenant on one of this owner's active leases, narrowed to the
    // announcement's property when it targets one.
    const { data: leases, error: leaseError } = await admin
      .from("leases")
      .select("tenant_user_id, units!inner(property_id)")
      .eq("owner_id", announcement.owner_id)
      .eq("status", "active")
      .not("tenant_user_id", "is", null);
    if (leaseError) return json({ error: leaseError.message }, 500);

    const ids = new Set<string>();
    for (const lease of leases ?? []) {
      const propertyId = (lease.units as { property_id: string } | null)
        ?.property_id;
      if (announcement.property_id && propertyId !== announcement.property_id) {
        continue;
      }
      if (lease.tenant_user_id) ids.add(lease.tenant_user_id);
    }

    title = clamp(announcement.title, 60);
    body = clamp(announcement.body ?? "Tap to read the full notice.");
    recipients = [...ids].map((userId) => ({ userId, url: "/tenant" }));
    data = { url: "/tenant", announcementId: String(announcement.id) };
  } else {
    return json({ error: `Unknown event: ${event}` }, 400);
  }

  if (recipients.length === 0) return json({ sent: 0, recipients: 0 });

  // Drop anyone who muted this kind of notification. A missing prefs row means
  // everything is on, so a user who never opened the settings still hears.
  const { data: prefs, error: prefError } = await admin
    .from("notification_prefs")
    .select("user_id, push_enabled, requests, messages, announcements")
    .in(
      "user_id",
      recipients.map((r) => r.userId),
    );
  if (prefError) return json({ error: prefError.message }, 500);

  const column = PREF_COLUMN[event];
  const muted = new Set(
    (prefs ?? [])
      .filter((p) => !p.push_enabled || p[column] === false)
      .map((p) => p.user_id),
  );
  const wanted = recipients.filter((r) => !muted.has(r.userId));
  if (wanted.length === 0) {
    return json({ sent: 0, recipients: recipients.length, reason: "muted" });
  }

  const { data: tokens, error: tokenError } = await admin
    .from("push_tokens")
    .select("token, user_id")
    .in(
      "user_id",
      wanted.map((r) => r.userId),
    );
  if (tokenError) return json({ error: tokenError.message }, 500);
  if (!tokens || tokens.length === 0) {
    return json({ sent: 0, recipients: wanted.length, reason: "no devices" });
  }

  const urlFor = new Map(wanted.map((r) => [r.userId, r.url]));
  const messages: ExpoMessage[] = tokens.map((t) => ({
    to: t.token,
    title,
    body,
    sound: "default",
    channelId: "default",
    data: { ...data, url: urlFor.get(t.user_id) ?? data.url ?? "/" },
  }));

  let sent = 0;
  const stale: string[] = [];

  for (const batch of chunked(messages, CHUNK)) {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify(batch),
    });

    if (!response.ok) continue;
    const result = (await response.json()) as {
      data?: { status: string; details?: { error?: string } }[];
    };

    (result.data ?? []).forEach((ticket, index) => {
      if (ticket.status === "ok") {
        sent += 1;
        return;
      }
      // The device uninstalled the app or revoked permission — drop the token
      // so it stops costing a round trip on every future send.
      if (ticket.details?.error === "DeviceNotRegistered") {
        stale.push(batch[index].to);
      }
    });
  }

  if (stale.length > 0) {
    await admin.from("push_tokens").delete().in("token", stale);
  }

  return json({ sent, recipients: wanted.length, dropped: stale.length });
});
