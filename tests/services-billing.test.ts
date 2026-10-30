import test from "node:test";
import assert from "node:assert/strict";
import { billingArguments, lemonEvent, paypalEvent, verifyHmac } from "../supabase/functions/_shared/billing.ts";
import { boundedBody, HttpError, parseObject, safeEqual } from "../supabase/functions/_shared/http.ts";
import { accepted, chunked, escapeHtml, notificationEmail, reminderCalendar, safeDeliveryMap } from "../supabase/functions/_shared/notifications.ts";

const uid = "11111111-1111-4111-8111-111111111111";
function lemon() { return { meta: { event_name: "subscription_updated", custom_data: { user_id: uid } }, data: { id: "123", type: "subscriptions", attributes: { variant_id: 45, store_id: 67, test_mode: false, status: "active", updated_at: "2026-10-26T12:00:00Z", renews_at: "2026-11-26T12:00:00Z", customer_id: 9 } } }; }
const config = { variantId: "45", storeId: "67", testMode: false };
const bad = (fn: () => unknown, status = 400) => assert.throws(fn, error => error instanceof HttpError && error.status === status);

test("Lemon Squeezy only grants configured subscription product and environment", () => {
  const event = lemonEvent(lemon(), config)!;
  assert.equal(event.ownerId, uid); assert.equal(event.plan, "pro"); assert.equal(event.occurredAt, "2026-10-26T12:00:00.000Z");
  assert.equal(lemonEvent(lemon(), { ...config, variantId: "other" }), null);
  assert.equal(lemonEvent(lemon(), { ...config, storeId: "other" }), null);
  assert.equal(lemonEvent(lemon(), { ...config, testMode: true }), null);
  const wrongType = lemon(); wrongType.data.type = "subscription-invoices";
  bad(() => lemonEvent(wrongType, config));
});
test("Missing owner binding is unmatched; buyer email never grants another account access", () => {
  const payload = lemon(); payload.meta.custom_data.user_id = "not-an-account";
  Object.assign(payload.data.attributes, { user_email: "victim@example.com" });
  const event = lemonEvent(payload, config)!;
  assert.equal(event.ownerId, null); assert.equal(billingArguments(event).p_owner_id, null);
});
test("Unknown event cannot mutate entitlement; malformed known event fails", () => {
  const payload = lemon(); payload.meta.event_name = "order_created";
  assert.equal(lemonEvent(payload, config), null);
  const invalidDate = lemon(); invalidDate.data.attributes.updated_at = "2026-10-26";
  bad(() => lemonEvent(invalidDate, config));
  const invalidState = lemon(); invalidState.data.attributes.status = "invented";
  bad(() => lemonEvent(invalidState, config));
  bad(() => lemonEvent({ meta: {}, data: null }, config));
});
test("Inherited object property names cannot masquerade as known billing statuses", () => {
  for (const status of ["__proto__", "constructor", "toString", "valueOf"]) {
    const ls = lemon(); ls.data.attributes.status = status;
    bad(() => lemonEvent(ls, config));
    const pp = { id: "WH-1", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", create_time: "2026-10-26T12:00:00Z", resource: { id: "I-1", plan_id: "P-1", status } };
    bad(() => paypalEvent(pp, "P-1"));
  }
});
test("Event IDs remain stable across replay and timestamp normalization", () => {
  const first = lemonEvent(lemon(), config)!;
  const secondPayload = lemon(); secondPayload.data.attributes.updated_at = "2026-10-26T08:00:00-04:00";
  assert.equal(first.eventId, lemonEvent(secondPayload, config)!.eventId);
  assert.equal(billingArguments(first).p_subscription_id, "123");
});
test("Provider calendar timestamps reject normalized impossible dates and preserve microseconds", () => {
  for (const timestamp of ["2026-02-29T12:00:00Z", "2028-02-30T12:00:00Z", "2026-04-31T12:00:00Z", "2026-10-26T24:00:00Z", "2026-10-26T12:60:00Z", "2026-10-26T12:00:00+24:00", "2026-10-26T12:00:00.1234567Z"]) {
    const payload = lemon(); payload.data.attributes.updated_at = timestamp;
    bad(() => lemonEvent(payload, config));
  }
  const first = lemon(); first.data.attributes.updated_at = "2028-02-29T08:00:00.123456-04:00";
  const second = lemon(); second.data.attributes.updated_at = "2028-02-29T12:00:00.123457Z";
  assert.equal(lemonEvent(first, config)!.occurredAt, "2028-02-29T12:00:00.123456Z");
  assert.notEqual(lemonEvent(first, config)!.eventId, lemonEvent(second, config)!.eventId);
  const same = lemon(); same.data.attributes.updated_at = "2028-02-29T12:00:00.123456Z";
  assert.equal(lemonEvent(first, config)!.eventId, lemonEvent(same, config)!.eventId);
});
test("Different subscription states within one provider second do not collide as duplicate events", () => {
  const active = lemon(), cancelled = lemon(), changedPeriod = lemon();
  cancelled.data.attributes.status = "cancelled";
  changedPeriod.data.attributes.renews_at = "2026-12-26T12:00:00Z";
  assert.notEqual(lemonEvent(active, config)!.eventId, lemonEvent(cancelled, config)!.eventId);
  assert.notEqual(lemonEvent(active, config)!.eventId, lemonEvent(changedPeriod, config)!.eventId);
  assert.equal(lemonEvent(active, config)!.eventId, lemonEvent(lemon(), config)!.eventId);
});
test("Missing product identity is malformed, while an explicit other authenticated product is ignored", () => {
  const missing = lemon(); Object.assign(missing.data.attributes, { variant_id: null });
  bad(() => lemonEvent(missing, config));
  const missingEnvironment = lemon(); Object.assign(missingEnvironment.data.attributes, { test_mode: null });
  bad(() => lemonEvent(missingEnvironment, config));
  bad(() => paypalEvent({ event_type: "BILLING.SUBSCRIPTION.UPDATED", resource: { status: "ACTIVE" } }, "P-1"));
});
test("Paused/unpaid/expired subscription never grants Pro", () => {
  for (const status of ["paused", "unpaid", "expired"]) { const payload = lemon(); payload.data.attributes.status = status; assert.equal(lemonEvent(payload, config)!.plan, "free"); }
});
test("HMAC rejects wrong key, changed body and malformed signature", async () => {
  const raw = JSON.stringify(lemon());
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("fixture-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map(value => value.toString(16).padStart(2, "0")).join("");
  assert.equal(await verifyHmac(raw, signature, "fixture-secret"), true);
  assert.equal(await verifyHmac(raw, signature.toUpperCase(), "fixture-secret"), true);
  assert.equal(await verifyHmac(raw + " ", signature, "fixture-secret"), false);
  assert.equal(await verifyHmac(raw, signature, "another-key"), false);
  for (const value of ["", "0".repeat(63), "x".repeat(64), signature + "00"]) assert.equal(await verifyHmac(raw, value, "fixture-secret"), false);
});
test("PayPal requires configured plan and event identity while treating custom_id as an untrusted hint", () => {
  const payload = { id: "WH-1", event_type: "BILLING.SUBSCRIPTION.ACTIVATED", create_time: "2026-10-26T12:00:00Z", resource: { id: "I-1", plan_id: "P-1", status: "ACTIVE", custom_id: uid, subscriber: { email_address: "other@example.com", payer_id: "payer" } } };
  assert.equal(paypalEvent(payload, "P-1")!.ownerId, uid);
  assert.equal(paypalEvent(payload, "wrong"), null);
  payload.resource.custom_id = "";
  assert.equal(paypalEvent(payload, "P-1")!.ownerId, null);
  payload.id = ""; bad(() => paypalEvent(payload, "P-1"));
});
test("Request size, malformed JSON and non-object bodies are bounded", async () => {
  const request = new Request("https://fixture.test", { method: "POST", body: "12345" });
  await assert.rejects(() => boundedBody(request, 4), error => error instanceof HttpError && error.status === 413);
  assert.equal(await boundedBody(new Request("https://fixture.test", { method: "POST", body: "{}" }), 2), "{}");
  for (const value of ["null", "[]", "123", "invalid"]) bad(() => parseObject(value));
  assert.deepEqual(parseObject('{"ok":true}'), { ok: true });
  assert.equal(safeEqual("fixture-secret", "fixture-secret"), true); assert.equal(safeEqual("fixture-secret-extra", "fixture-secret"), false);
});
test("Chunked and invalid UTF-8 bodies are bounded before parsing", async () => {
  const streamed = new Request("https://fixture.test", { method: "POST", body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([123, 34, 97])); controller.enqueue(new Uint8Array([34, 58, 49, 125])); controller.close(); } }), duplex: "half" } as RequestInit);
  await assert.rejects(() => boundedBody(streamed, 6), error => error instanceof HttpError && error.status === 413);
  const invalid = new Request("https://fixture.test", { method: "POST", body: new Uint8Array([0xc0, 0xaf]) });
  await assert.rejects(() => boundedBody(invalid), error => error instanceof HttpError && error.status === 400);
});
test("Notification rendering escapes untrusted content in HTML and retains readable text", () => {
  const content = notificationEmail('Fix <img src=x onerror="attack()">', "A&B 'quoted'");
  assert.equal(content.html.includes("<img"), false); assert.ok(content.html.includes("&lt;img"));
  assert.ok(content.text.includes("<img")); assert.equal(escapeHtml("<&>\"'"), "&lt;&amp;&gt;&quot;&#39;");
});
test("Receipt states distinguish acceptance, delivery and failures", () => {
  const delivery = { status: "accepted", channel: "push", userId: uid, ticketId: "receipt", attemptedAt: "2026-10-26" } as const;
  assert.equal(accepted(delivery), true); assert.equal(accepted({ ...delivery, status: "failed" }), false);
  assert.deepEqual(safeDeliveryMap({ good: delivery, bad: { status: "invented" } }), { good: delivery });
  assert.deepEqual(chunked([1, 2, 3], 2), [[1, 2], [3]]); assert.throws(() => chunked([1], 0));
});
test("Reminder calendar handles local dates, leap days and midnight west of UTC", () => {
  assert.deepEqual(reminderCalendar(new Date("2026-10-26T01:00:00Z"), "America/St_Lucia"), { today: "2026-10-25", soon: "2026-11-24", hour: 21 });
  assert.equal(reminderCalendar(new Date("2028-02-01T12:00:00Z"), "UTC").soon, "2028-03-02");
  assert.throws(() => reminderCalendar(new Date(), "not/a-zone"));
});
