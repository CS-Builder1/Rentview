import { createClient } from "jsr:@supabase/supabase-js@2.109.0";
import { billingArguments, paypalEvent } from "../_shared/billing.ts";
import { boundedBody, errorResponse, fetchWithTimeout, HttpError, json, parseObject } from "../_shared/http.ts";

Deno.serve(async req => {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const clientId = Deno.env.get("PAYPAL_CLIENT_ID"), secret = Deno.env.get("PAYPAL_SECRET");
    const webhookId = Deno.env.get("PAYPAL_WEBHOOK_ID"), planId = Deno.env.get("PAYPAL_PLAN_ID");
    const environment = Deno.env.get("PAYPAL_ENV");
    if (!clientId || !secret || !webhookId || !planId || !["sandbox", "live"].includes(environment ?? "")) throw new HttpError(503, "Billing is not available yet");
    const requiredHeaders = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];
    if (requiredHeaders.some(name => !req.headers.get(name))) throw new HttpError(401, "Missing verification headers");
    const payload = parseObject(await boundedBody(req));
    const apiBase = environment === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
    const authResponse = await fetchWithTimeout(`${apiBase}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
    if (!authResponse.ok) throw new HttpError(503, "Billing verification is temporarily unavailable");
    const auth = await authResponse.json();
    if (typeof auth.access_token !== "string") throw new HttpError(503, "Billing verification is temporarily unavailable");
    const verification = await fetchWithTimeout(`${apiBase}/v1/notifications/verify-webhook-signature`, { method: "POST", headers: { Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ auth_algo: req.headers.get("paypal-auth-algo"), cert_url: req.headers.get("paypal-cert-url"), transmission_id: req.headers.get("paypal-transmission-id"), transmission_sig: req.headers.get("paypal-transmission-sig"), transmission_time: req.headers.get("paypal-transmission-time"), webhook_id: webhookId, webhook_event: payload }) });
    if (!verification.ok) throw new HttpError(503, "Billing verification is temporarily unavailable");
    if ((await verification.json()).verification_status !== "SUCCESS") throw new HttpError(401, "Invalid signature");
    const event = paypalEvent(payload, planId);
    if (!event) return json({ ignored: true });
    // Neither a provider email address nor customer-controlled custom_id proves
    // application ownership. Only a previously registered service-owned provider
    // subscription binding resolves the account inside the RPC.
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data, error } = await admin.rpc("apply_billing_event", billingArguments(event));
    if (error) throw error;
    return json({ result: data }, ["unmatched", "ambiguous"].includes(data) ? 202 : 200);
  } catch (error) { return errorResponse(error); }
});
