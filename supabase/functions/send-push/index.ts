// Push notifications for tenant-portal activity, delivered via Expo's push
// service (https://exp.host/--/api/v2/push/send).
//
// The app calls this right after it writes the row that should notify someone.
// The CALLER never says who to notify: the function loads the row with the
// service role, checks that the caller is a participant, and derives the
// recipient itself. So a caller can only ever trigger a notification about a
// row it is already allowed to see, and never learns the recipient's tokens.
//
// Events:
//   request_created  — tenant filed a request        -> notify the owner
//   request_updated  — status changed                -> notify the other party
//   request_message  — someone posted on the thread  -> notify the other party
//   announcement     — owner posted a notice         -> notify its tenants
//
// No secrets beyond the defaults Supabase injects. Expo's push service needs
// no API key for tokens issued to your own project.

import { createClient } from "jsr:@supabase/supabase-js@2";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const CHUNK = 100;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Event =
  | "request_created"
  | "request_updated"
  | "request_message"
  | "announcement";

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
    headers: { ...corsHeaders, "Content-Type": "application/json" },
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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing session" }, 401);

  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: "Invalid session" }, 401);

  let payload: { event?: Event; id?: string; preview?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Expected a JSON body" }, 400);
  }
  const { event, id, preview } = payload;
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

    const isOwner = request.owner_id === user.id;
    const isTenant = request.tenant_user_id === user.id;
    if (!isOwner && !isTenant) return json({ error: "Not your request" }, 403);

    // The person who acted never gets their own notification.
    const recipientId = isOwner ? request.tenant_user_id : request.owner_id;
    const recipientIsOwner = !isOwner;
    if (!recipientId) return json({ sent: 0, recipients: 0 });

    const unit = (request.units as { label: string } | null)?.label;
    const property = (request.properties as { name: string } | null)?.name;
    const place = [property, unit].filter(Boolean).join(" · ");

    if (event === "request_created") {
      title = "New repair request";
      body = clamp(place ? `${place}: ${request.title}` : request.title);
    } else if (event === "request_updated") {
      title = "Request updated";
      body = clamp(`${request.title} — ${String(request.status).replace(/_/g, " ")}`);
    } else {
      title = "New message";
      body = clamp(preview ? preview : `About: ${request.title}`);
    }

    recipients = [
      {
        userId: recipientId,
        url: recipientIsOwner ? `/request/${request.id}` : `/tenant/request/${request.id}`,
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
    if (announcement.owner_id !== user.id) {
      return json({ error: "Not your announcement" }, 403);
    }

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

  const { data: tokens, error: tokenError } = await admin
    .from("push_tokens")
    .select("token, user_id")
    .in(
      "user_id",
      recipients.map((r) => r.userId),
    );
  if (tokenError) return json({ error: tokenError.message }, 500);
  if (!tokens || tokens.length === 0) {
    return json({ sent: 0, recipients: recipients.length, reason: "no devices" });
  }

  const urlFor = new Map(recipients.map((r) => [r.userId, r.url]));
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

  return json({ sent, recipients: recipients.length, dropped: stale.length });
});
