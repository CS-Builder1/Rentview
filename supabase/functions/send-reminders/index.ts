// Bounded, claim-based daily digests. Due owners are selected in the database,
// not by scanning only the first Auth users page. Scheduled retries drain the
// backlog; a deterministic Resend idempotency key prevents duplicate emails.
import { createClient } from "jsr:@supabase/supabase-js@2.109.0";
import { errorResponse, fetchWithTimeout, HttpError, json, safeEqual } from "../_shared/http.ts";
import { escapeHtml, reminderCalendar } from "../_shared/notifications.ts";

Deno.serve(async req => {
  try {
    if (req.method === "OPTIONS") return json({ ok: true }, 200, true);
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const url = Deno.env.get("SUPABASE_URL")!, key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, key, { auth: { persistSession: false } });
    const cronSecret = Deno.env.get("CRON_SECRET"), suppliedCron = req.headers.get("x-cron-secret");
    const scheduled = !!cronSecret && safeEqual(suppliedCron ?? "", cronSecret);
    if (suppliedCron && !scheduled) throw new HttpError(401, "Unauthorized");
    let caller: { id: string; email?: string; email_confirmed_at?: string } | null = null;
    if (!scheduled) {
      const header = req.headers.get("authorization");
      if (!header?.startsWith("Bearer ")) throw new HttpError(401, "Unauthorized");
      const { data, error } = await admin.auth.getUser(header.slice(7));
      if (error || !data.user) throw new HttpError(401, "Invalid session");
      caller = data.user;
    }
    const resendKey = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("REMINDERS_FROM");
    const emailConfigured = !!resendKey && !!from;
    if (!emailConfigured) return json({ emailConfigured: false, dueUsers: 0, sent: 0, message: "Email reminders are not available yet." }, 200, true);
    const calendar = reminderCalendar(new Date(), Deno.env.get("REMINDERS_TIMEZONE") ?? "UTC");
    const sendHour = Number(Deno.env.get("REMINDERS_LOCAL_HOUR") ?? "9");
    if (!Number.isInteger(sendHour) || sendHour < 0 || sendHour > 23) throw new HttpError(503, "Reminder schedule is unavailable");
    if (scheduled && calendar.hour < sendHour) return json({ emailConfigured, dueUsers: 0, sent: 0, scheduledLater: true }, 200, true);
    let owners: { owner_id: string }[];
    if (caller) owners = [{ owner_id: caller.id }];
    else {
      const { data, error } = await admin.rpc("due_reminder_owners", { p_today: calendar.today, p_soon: calendar.soon, p_limit: 25 });
      if (error) throw error;
      owners = data ?? [];
    }
    let dueUsers = 0, sent = 0, failed = 0, alreadySent = 0;
    const deadline = Date.now() + 70_000;
    for (const owner of owners) {
      if (Date.now() > deadline) break; // Remaining owners stay eligible for the next scheduled batch.
      const [warrantyResult, maintenanceResult] = await Promise.all([
        admin.from("assets").select("name,warranty_expiry,properties!assets_property_id_owner_fk(name)").eq("owner_id", owner.owner_id).not("warranty_expiry", "is", null).gte("warranty_expiry", calendar.today).lte("warranty_expiry", calendar.soon).order("warranty_expiry").limit(500),
        admin.from("maintenance_schedules").select("title,next_due,properties!maintenance_schedules_property_id_owner_fk(name)").eq("owner_id", owner.owner_id).eq("is_active", true).not("next_due", "is", null).lte("next_due", calendar.today).order("next_due").limit(500),
      ]);
      if (warrantyResult.error) throw warrantyResult.error;
      if (maintenanceResult.error) throw maintenanceResult.error;
      const warranties = warrantyResult.data ?? [], maintenance = maintenanceResult.data ?? [];
      if (!warranties.length && !maintenance.length) continue;
      dueUsers++;
      const { data: claimData, error: claimError } = await admin.rpc("claim_reminder", { p_owner_id: owner.owner_id, p_day: calendar.today }).maybeSingle();
      if (claimError) throw claimError;
      const claim = claimData as { id: string; claim_token: string } | null;
      if (!claim?.id) { alreadySent++; continue; }
      try {
        const { data: account, error: accountError } = await admin.auth.admin.getUserById(owner.owner_id);
        if (accountError) throw accountError;
        if (!account.user?.email || !account.user.email_confirmed_at) throw new Error("Verified email required");
        const property = (value: unknown) => {
          const item = Array.isArray(value) ? value[0] : value;
          return item && typeof item === "object" && "name" in item ? String(item.name) : "";
        };
        const lines = [
          ...warranties.map(item => `${item.name}${property(item.properties) ? ` (${property(item.properties)})` : ""} — warranty expires ${item.warranty_expiry}`),
          ...maintenance.map(item => `${item.title}${property(item.properties) ? ` (${property(item.properties)})` : ""} — maintenance due ${item.next_due}`),
        ];
        const text = `RentView warranty and maintenance reminders\n\n${lines.join("\n")}\n\nOpen RentView to see all due items and manage your records.`;
        const html = `<!doctype html><html lang="en"><head><title>RentView reminders</title></head><body><h1>Warranty and maintenance reminders</h1><ul>${lines.map(line => `<li>${escapeHtml(line)}</li>`).join("")}</ul><p>Open RentView to see all due items and manage your records.</p></body></html>`;
        const response = await fetchWithTimeout("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json", "Idempotency-Key": `rentview-reminder-${owner.owner_id}-${calendar.today}` }, body: JSON.stringify({ from, to: account.user.email, subject: "RentView: warranty and maintenance reminders", html, text }) });
        if (!response.ok) throw new Error(`Email service HTTP ${response.status}`);
        const receipt = await response.json();
        const { error } = await admin.rpc("finish_reminder", { p_id: claim.id, p_claim_token: claim.claim_token, p_success: true, p_provider_id: typeof receipt.id === "string" ? receipt.id : null });
        if (error) throw error;
        sent++;
      } catch {
        const { error } = await admin.rpc("finish_reminder", { p_id: claim.id, p_claim_token: claim.claim_token, p_success: false, p_error: "Reminder could not be delivered; retry scheduled" });
        if (error) throw error;
        failed++;
      }
    }
    return json({ emailConfigured, dueUsers, sent, failed, alreadySent, targets: owners.length, moreMayRemain: owners.length === 25 }, 200, true);
  } catch (error) { return errorResponse(error, true); }
});
