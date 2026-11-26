import { createClient } from "jsr:@supabase/supabase-js@2.109.0";
import { billingArguments, lemonEvent, verifyHmac } from "../_shared/billing.ts";
import { boundedBody, errorResponse, HttpError, json, parseObject } from "../_shared/http.ts";

Deno.serve(async req => {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const secret = Deno.env.get("LEMONSQUEEZY_WEBHOOK_SECRET");
    const variantId = Deno.env.get("LEMONSQUEEZY_VARIANT_ID"), storeId = Deno.env.get("LEMONSQUEEZY_STORE_ID");
    if (!secret || !variantId || !storeId) throw new HttpError(503, "Billing is not available yet");
    const raw = await boundedBody(req);
    if (!(await verifyHmac(raw, req.headers.get("x-signature") ?? "", secret))) throw new HttpError(401, "Invalid signature");
    const event = lemonEvent(parseObject(raw), { variantId, storeId, testMode: Deno.env.get("LEMONSQUEEZY_TEST_MODE") === "true" });
    if (!event) return json({ ignored: true });
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    // Checkout custom_data can be changed by a customer. The RPC requires an
    // independently registered service-owned subscription binding; otherwise it
    // records this verified event as unmatched without granting any access.
    const { data, error } = await admin.rpc("apply_billing_event", billingArguments(event));
    if (error) throw error; // No event is marked applied unless the same transaction updates access.
    return json({ result: data }, ["unmatched", "ambiguous"].includes(data) ? 202 : 200);
  } catch (error) { return errorResponse(error); }
});
