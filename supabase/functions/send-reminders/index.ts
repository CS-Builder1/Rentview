// Warranty + preventive-maintenance reminders by email (via Resend).
//
// Two ways to call it:
//   * On-demand: the app invokes it with the user's JWT -> emails that user.
//   * Scheduled: pg_cron POSTs with header `x-cron-secret: <CRON_SECRET>`
//     -> emails every user who has due items.
//
// Required secret to actually send: RESEND_API_KEY. Optional: REMINDERS_FROM
// (defaults to Resend's shared test sender) and CRON_SECRET (for the cron mode).

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const WINDOW_DAYS = 30;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("REMINDERS_FROM") ?? "RentView <onboarding@resend.dev>";
  const cronSecret = Deno.env.get("CRON_SECRET");

  const admin = createClient(url, serviceKey);

  // Resolve who to notify.
  let targets: { userId: string; email: string | null }[] = [];
  const providedCronSecret = req.headers.get("x-cron-secret");
  const authHeader = req.headers.get("Authorization");

  if (cronSecret && providedCronSecret === cronSecret) {
    const { data, error } = await admin.auth.admin.listUsers();
    if (error) return json({ error: error.message }, 500);
    targets = data.users.map((u) => ({ userId: u.id, email: u.email ?? null }));
  } else if (authHeader) {
    const userClient = createClient(url, anon, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error,
    } = await userClient.auth.getUser();
    if (error || !user) return json({ error: "Invalid session" }, 401);
    targets = [{ userId: user.id, email: user.email ?? null }];
  } else {
    return json({ error: "Unauthorized" }, 401);
  }

  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + WINDOW_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);

  let sent = 0;
  let dueUsers = 0;

  for (const t of targets) {
    const [{ data: warranties }, { data: maint }] = await Promise.all([
      admin
        .from("assets")
        .select("name, warranty_expiry, properties(name)")
        .eq("owner_id", t.userId)
        .not("warranty_expiry", "is", null)
        .gte("warranty_expiry", today)
        .lte("warranty_expiry", soon)
        .order("warranty_expiry"),
      admin
        .from("maintenance_schedules")
        .select("title, next_due, properties(name)")
        .eq("owner_id", t.userId)
        .eq("is_active", true)
        .not("next_due", "is", null)
        .lte("next_due", today)
        .order("next_due"),
    ]);

    const w = warranties ?? [];
    const m = maint ?? [];
    if (w.length === 0 && m.length === 0) continue;
    dueUsers += 1;

    if (!resendKey || !t.email) continue; // nothing to send with / to

    const wList = w
      .map(
        (a: any) =>
          `<li>${a.name}${a.properties?.name ? ` (${a.properties.name})` : ""} — warranty expires ${a.warranty_expiry}</li>`,
      )
      .join("");
    const mList = m
      .map(
        (s: any) =>
          `<li>${s.title}${s.properties?.name ? ` (${s.properties.name})` : ""} — due ${s.next_due}</li>`,
      )
      .join("");

    const html = `
      <h2>RentView reminders</h2>
      ${w.length ? `<h3>Warranties expiring within ${WINDOW_DAYS} days</h3><ul>${wList}</ul>` : ""}
      ${m.length ? `<h3>Maintenance due</h3><ul>${mList}</ul>` : ""}
      <p style="color:#64748b;font-size:12px">For your records — RentView is not tax or accounting advice.</p>
    `;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: t.email,
        subject: "RentView: warranty & maintenance reminders",
        html,
      }),
    });
    if (resp.ok) sent += 1;
  }

  return json({
    ok: true,
    emailConfigured: !!resendKey,
    targets: targets.length,
    dueUsers,
    sent,
  });
});
