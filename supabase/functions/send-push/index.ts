// Only dispatch persisted database events. Never accept client-supplied recipients,
// message bodies or arbitrary URLs. Queue retries and accepted Expo tickets survive
// worker crashes; Expo delivery remains at-least-once, not exactly-once.
import { createClient } from "jsr:@supabase/supabase-js@2.109.0";
import { UUID } from "../_shared/billing.ts";
import { asObject, boundedBody, errorResponse, fetchWithTimeout, HttpError, json, parseObject, safeEqual } from "../_shared/http.ts";
import { accepted, chunked, clamp, type Deliveries, notificationEmail, safeDeliveryMap } from "../_shared/notifications.ts";

const EXPO_SEND = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS = "https://exp.host/--/api/v2/push/getReceipts";
const PREF = { request_created: "requests", request_updated: "requests", request_message: "messages", announcement: "announcements" } as const;
type Event = keyof typeof PREF;
type Recipient = { userId: string; url: string };
type Job = { id: string; event: Event; row_id: string; actor_id: string | null; preview: string | null; claim_token: string; attempts: number; deliveries: unknown };
const relation = (value: unknown): Record<string, unknown> => {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
};

Deno.serve(async req => {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const secret = Deno.env.get("PUSH_HOOK_SECRET");
    if (!secret) throw new HttpError(503, "Notifications are not available yet");
    if (!safeEqual(req.headers.get("x-push-secret") ?? "", secret)) throw new HttpError(401, "Unauthorized");
    const payload = parseObject(await boundedBody(req, 4096));
    if (payload.outbox_id != null && (typeof payload.outbox_id !== "string" || !UUID.test(payload.outbox_id))) throw new HttpError(400, "Invalid notification identifier");
    if (Object.keys(payload).some(key => key !== "outbox_id")) throw new HttpError(400, "Only a persisted notification identifier is accepted");
    const deadline = Date.now() + 70_000;
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    // Receipts are distinct from initial acceptance. Save their outcomes and remove
    // stale tokens without losing the original attempts. A failed receipt requeues
    // the job, allowing email fallback if a mobile installation no longer exists.
    const { data: receiptJobs, error: receiptQueryError } = await admin.from("notification_outbox").select("id,deliveries,attempts").eq("status", "sent").eq("receipt_pending", true).gte("completed_at", new Date(Date.now() - 24 * 3600_000).toISOString()).order("completed_at").limit(50);
    if (receiptQueryError) throw receiptQueryError;
    const ticketMap = new Map<string, { job: { id: string; deliveries: unknown; attempts: number }; key: string }>();
    for (const job of receiptJobs ?? []) for (const [key, delivery] of Object.entries(safeDeliveryMap(job.deliveries))) {
      if (delivery.channel === "push" && delivery.status === "accepted" && delivery.ticketId) ticketMap.set(delivery.ticketId, { job, key });
    }
    if (ticketMap.size) {
      const response = await fetchWithTimeout(EXPO_RECEIPTS, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [...ticketMap.keys()].slice(0, 1000) }) });
      if (response.ok) {
        const results = asObject((await response.json()).data ?? {});
        const updates = new Map<string, { deliveries: Deliveries; failed: boolean }>();
        for (const [ticketId, resultValue] of Object.entries(results)) {
          const reference = ticketMap.get(ticketId); if (!reference) continue;
          const result = asObject(resultValue), deliveryMap = updates.get(reference.job.id)?.deliveries ?? safeDeliveryMap(reference.job.deliveries);
          const delivery = deliveryMap[reference.key];
          if (result.status === "ok") delivery.status = "delivered";
          else if (result.status === "error") {
            delivery.status = "failed"; delivery.error = String(relation(result.details).error ?? "Push delivery failed");
            if (delivery.error === "DeviceNotRegistered") {
              const { error } = await admin.from("push_tokens").delete().eq("token", reference.key.slice(5)).eq("user_id", delivery.userId);
              if (error) throw error;
            }
          }
          updates.set(reference.job.id, { deliveries: deliveryMap, failed: (updates.get(reference.job.id)?.failed ?? false) || delivery.status === "failed" });
        }
        for (const [id, update] of updates) {
          const { error } = await admin.from("notification_outbox").update({ deliveries: update.deliveries, receipt_pending: Object.values(update.deliveries).some(delivery => delivery.channel === "push" && delivery.status === "accepted"), ...(update.failed ? { status: "pending", next_attempt_at: new Date().toISOString() } : {}) }).eq("id", id).eq("status", "sent");
          if (error) throw error;
        }
      }
    }

    const { data: jobs, error: claimError } = await admin.rpc("claim_notification_batch", { p_limit: 3, p_id: payload.outbox_id ?? null });
    if (claimError) throw claimError;
    let completed = 0, deferred = 0;
    for (const job of (jobs ?? []) as Job[]) {
      const deliveries = safeDeliveryMap(job.deliveries);
      try {
        let recipients: Recipient[] = [], title = "RentView", body = "";
        if (!(job.event in PREF)) throw new Error("Unsupported persisted notification event");
        if (job.event === "announcement") {
          const { data: announcement, error } = await admin.from("announcements").select("id,title,body,owner_id,property_id").eq("id", job.row_id).maybeSingle();
          if (error) throw error;
          if (announcement && job.actor_id === announcement.owner_id) {
            let offset = 0;
            const ids = new Set<string>();
            for (;;) {
              const { data: leases, error: leaseError } = await admin.from("leases").select("tenant_user_id,units!leases_unit_id_owner_fk!inner(property_id)").eq("owner_id", announcement.owner_id).eq("status", "active").not("tenant_user_id", "is", null).order("id").range(offset, offset + 499);
              if (leaseError) throw leaseError;
              for (const lease of leases ?? []) if (!announcement.property_id || relation(lease.units).property_id === announcement.property_id) ids.add(lease.tenant_user_id);
              if ((leases?.length ?? 0) < 500) break; offset += 500;
            }
            recipients = [...ids].map(userId => ({ userId, url: "/tenant" }));
            title = clamp(announcement.title, 60); body = clamp(announcement.body ?? "Open RentView to read the notice.");
          }
        } else {
          const { data: request, error } = await admin.from("maintenance_requests").select("id,lease_id,title,status,owner_id,tenant_user_id,units!maintenance_requests_unit_property_owner_fk(label),properties!maintenance_requests_property_id_owner_fk(name)").eq("id", job.row_id).maybeSingle();
          if (error) throw error;
          if (request?.tenant_user_id && (job.actor_id === request.owner_id || job.actor_id === request.tenant_user_id)) {
            const { data: lease, error: leaseError } = await admin.from("leases").select("id").eq("id", request.lease_id).eq("owner_id", request.owner_id).eq("tenant_user_id", request.tenant_user_id).eq("status", "active").maybeSingle();
            if (leaseError) throw leaseError;
            if (lease) {
              const ownerActed = job.actor_id === request.owner_id;
              recipients = [{ userId: ownerActed ? request.tenant_user_id : request.owner_id, url: ownerActed ? `/tenant/request/${request.id}` : `/request/${request.id}` }];
              const place = [relation(request.properties).name, relation(request.units).label].filter(Boolean).join(" · ");
              title = job.event === "request_created" ? "New repair request" : job.event === "request_message" ? "New message" : "Request updated";
              body = clamp(job.event === "request_message" ? `A new message about ${request.title}.` : job.event === "request_created" ? `${place ? `${place}: ` : ""}${request.title}` : `${request.title} — ${String(request.status).replace(/_/g, " ")}`);
            }
          }
        }
        const failures: string[] = [];
        let unresolved = 0;
        for (const recipient of recipients) {
          if (Date.now() > deadline) { unresolved++; failures.push("More recipients remain; retry scheduled"); break; }
          if (Object.values(deliveries).some(delivery => delivery.userId === recipient.userId && (accepted(delivery) || delivery.status === "skipped"))) continue;
          const { data: prefs, error: prefError } = await admin.from("notification_prefs").select("push_enabled,email_enabled,requests,messages,announcements").eq("user_id", recipient.userId).maybeSingle();
          if (prefError) throw prefError;
          if (prefs?.[PREF[job.event]] === false || (prefs?.push_enabled === false && prefs?.email_enabled === false)) {
            deliveries[`skip:${recipient.userId}`] = { channel: "email", userId: recipient.userId, status: "skipped", error: "Notifications disabled", attemptedAt: new Date().toISOString() };
            continue;
          }
          const pushAllowed = prefs?.push_enabled !== false;
          const { data: tokens, error: tokenError } = await admin.from("push_tokens").select("token").eq("user_id", recipient.userId);
          if (tokenError) throw tokenError;
          let recipientAccepted = Object.values(deliveries).some(delivery => delivery.userId === recipient.userId && accepted(delivery));
          if (pushAllowed) for (const batch of chunked((tokens ?? []).filter(token => !accepted(deliveries[`push:${token.token}`])))) {
            const response = await fetchWithTimeout(EXPO_SEND, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(batch.map(token => ({ to: token.token, title, body, sound: "default", channelId: "default", data: { url: recipient.url, notificationId: job.id } }))) });
            if (!response.ok) { failures.push(`Push service HTTP ${response.status}`); continue; }
            const tickets = (await response.json()).data;
            if (!Array.isArray(tickets) || tickets.length !== batch.length) { failures.push("Incomplete push acceptance response"); continue; }
            for (let index = 0; index < batch.length; index++) {
              const ticket = relation(tickets[index]), key = `push:${batch[index].token}`;
              const error = String(relation(ticket.details).error ?? "Push not accepted");
              const ok = ticket.status === "ok" && typeof ticket.id === "string";
              deliveries[key] = { channel: "push", userId: recipient.userId, status: ok ? "accepted" : "failed", attemptedAt: new Date().toISOString(), ...(ok ? { ticketId: ticket.id as string } : { error }) };
              if (ok) recipientAccepted = true;
              else if (error === "DeviceNotRegistered") {
                const { error: deleteError } = await admin.from("push_tokens").delete().eq("token", batch[index].token).eq("user_id", recipient.userId);
                if (deleteError) throw deleteError;
              } else failures.push(error);
            }
          }
          // Transactional email is the fallback for web/no-device users and failed
          // push attempts. A deterministic provider key makes retries safe.
          if (!recipientAccepted && prefs?.email_enabled !== false) {
            const resendKey = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("NOTIFICATIONS_FROM") ?? Deno.env.get("REMINDERS_FROM");
            if (!resendKey || !from) failures.push("Email fallback is not configured");
            else {
              const { data: account, error: accountError } = await admin.auth.admin.getUserById(recipient.userId);
              if (accountError) throw accountError;
              if (account.user?.email && account.user.email_confirmed_at) {
                const content = notificationEmail(title, body);
                const response = await fetchWithTimeout("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json", "Idempotency-Key": `rentview-notification-${job.id}-${recipient.userId}` }, body: JSON.stringify({ from, to: account.user.email, subject: `RentView: ${title}`, ...content }) });
                if (response.ok) {
                  const receipt = await response.json();
                  deliveries[`email:${recipient.userId}`] = { channel: "email", userId: recipient.userId, status: "accepted", ticketId: typeof receipt.id === "string" ? receipt.id : undefined, attemptedAt: new Date().toISOString() };
                  recipientAccepted = true;
                } else failures.push(`Email service HTTP ${response.status}`);
              } else failures.push("No verified email address for fallback");
            }
          }
          if (!recipientAccepted && (pushAllowed || prefs?.email_enabled !== false)) { unresolved++; failures.push("No notification channel accepted the update"); }
          const { error: checkpointError } = await admin.from("notification_outbox").update({ deliveries }).eq("id", job.id).eq("claim_token", job.claim_token).eq("status", "processing");
          if (checkpointError) throw checkpointError;
        }
        const success = unresolved === 0;
        const { error } = await admin.rpc("finish_notification", { p_id: job.id, p_claim_token: job.claim_token, p_success: success, p_deliveries: deliveries, p_error: success ? null : failures.join("; ").slice(0, 500) });
        if (error) throw error;
        if (success) completed++; else deferred++;
      } catch (error) {
        const { error: finishError } = await admin.rpc("finish_notification", { p_id: job.id, p_claim_token: job.claim_token, p_success: false, p_deliveries: deliveries, p_error: "Delivery attempt failed; retry scheduled" });
        if (finishError) throw finishError;
        console.error("Notification attempt failed", error instanceof Error ? error.name : "unknown");
        deferred++;
      }
    }
    return json({ completed, deferred });
  } catch (error) { return errorResponse(error); }
});
