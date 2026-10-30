import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as billing from "../supabase/functions/_shared/billing.ts";
import * as http from "../supabase/functions/_shared/http.ts";
import * as notifications from "../supabase/functions/_shared/notifications.ts";

const uid = "11111111-1111-4111-8111-111111111111";
type Handler = (request: Request) => Promise<Response>;
function load(name: string, env: Record<string, string> = {}, admin: unknown = {}, fetchStub: typeof fetch = async () => { throw new Error("Unexpected network access in test"); }) {
  let handler: Handler | undefined, clients = 0;
  const source = readFileSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  // The target runs with fixture-only dependencies, no ambient environment, network
  // or backend credentials. Provider requests are explicitly stubbed per test.
  runInNewContext(code, {
    exports: {}, Deno: { env: { get: (key: string) => env[key] }, serve: (fn: Handler) => { handler = fn; } },
    require: (name: string) => {
      if (name === "jsr:@supabase/supabase-js@2.109.0") return { createClient: () => { clients++; return admin; } };
      if (name.endsWith("billing.ts")) return billing;
      if (name.endsWith("notifications.ts")) return notifications;
      if (name.endsWith("http.ts")) return { ...http, fetchWithTimeout: fetchStub };
      throw new Error(`Unexpected dependency ${name}`);
    },
    crypto, TextEncoder, TextDecoder, Request, Response, Headers, URL, Date, Map, Set, Promise,
    btoa, console: { error: () => undefined, log: () => undefined, warn: () => undefined },
  });
  assert.ok(handler);
  return { handle: handler, clients: () => clients };
}
const lemonEnv = { LEMONSQUEEZY_WEBHOOK_SECRET: "fixture-secret", LEMONSQUEEZY_VARIANT_ID: "45", LEMONSQUEEZY_STORE_ID: "67", SUPABASE_URL: "https://fixture.local", SUPABASE_SERVICE_ROLE_KEY: "fixture-key" };
const payload = () => ({ meta: { event_name: "subscription_updated", custom_data: { user_id: uid } }, data: { id: "123", type: "subscriptions", attributes: { variant_id: 45, store_id: 67, test_mode: false, status: "active", updated_at: "2026-10-26T12:00:00Z", renews_at: "2026-11-26T12:00:00Z" } } });
async function signed(raw: string): Promise<Request> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("fixture-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map(value => value.toString(16).padStart(2, "0")).join("");
  return new Request("https://fixture.local", { method: "POST", headers: { "x-signature": signature }, body: raw });
}

test("Lemon webhook rejects unsigned/malformed requests and acknowledges authentic foreign products without backend access", async () => {
  const fixture = load("lemonsqueezy-webhook", lemonEnv);
  assert.equal((await fixture.handle(new Request("https://fixture.local", { method: "POST", body: JSON.stringify(payload()) }))).status, 401);
  assert.equal((await fixture.handle(await signed("{broken"))).status, 400);
  const wrong = payload(); wrong.data.attributes.variant_id = 999;
  const ignored = await fixture.handle(await signed(JSON.stringify(wrong)));
  assert.equal(ignored.status, 200); assert.deepEqual(await ignored.json(), { ignored: true });
  assert.equal(fixture.clients(), 0);
  assert.equal((await load("lemonsqueezy-webhook").handle(new Request("https://fixture.local", { method: "POST", body: "{}" }))).status, 503);
});
test("Lemon retries call atomic billing operation again after failure without pre-inserting a dedupe record", async () => {
  const calls: unknown[] = [];
  let failing = true;
  const fixture = load("lemonsqueezy-webhook", lemonEnv, { rpc: async (name: string, args: unknown) => { calls.push({ name, args }); return { data: failing ? null : "applied", error: failing ? { message: "database fixture failure with secret details" } : null }; } });
  const first = await fixture.handle(await signed(JSON.stringify(payload())));
  assert.equal(first.status, 500); assert.equal((await first.text()).includes("secret details"), false);
  failing = false;
  assert.equal((await fixture.handle(await signed(JSON.stringify(payload())))).status, 200);
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  assert.equal((calls[0] as { name: string }).name, "apply_billing_event");
});
test("A customer-supplied account hint does not bypass an unmatched trusted subscription binding", async () => {
  let calls = 0;
  const fixture = load("lemonsqueezy-webhook", lemonEnv, { rpc: async (name: string, args: { p_owner_id: string; p_subscription_id: string }) => {
    calls++;
    assert.equal(name, "apply_billing_event");
    assert.equal(args.p_owner_id, uid); // Untrusted hint is checked inside the atomic operation.
    assert.equal(args.p_subscription_id, "123");
    return { data: "unmatched", error: null };
  } });
  const response = await fixture.handle(await signed(JSON.stringify(payload())));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { result: "unmatched" });
  assert.equal(calls, 1);
});
const paypalEnv = { PAYPAL_CLIENT_ID: "fixture-client", PAYPAL_SECRET: "fixture-secret", PAYPAL_WEBHOOK_ID: "fixture-webhook", PAYPAL_PLAN_ID: "P-1", PAYPAL_ENV: "sandbox" };
const paypalHeaders = { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/fixture.pem", "paypal-transmission-id": "fixture", "paypal-transmission-sig": "fixture", "paypal-transmission-time": "2026-10-26T12:00:00Z" };
test("PayPal missing headers or failed provider verification never writes billing", async () => {
  const fixture = load("paypal-webhook", paypalEnv, {}, async url => new Response(JSON.stringify(String(url).endsWith("/token") ? { access_token: "fixture-token" } : { verification_status: "FAILURE" }), { status: 200 }));
  assert.equal((await fixture.handle(new Request("https://fixture.local", { method: "POST", body: "{}" }))).status, 401);
  assert.equal((await fixture.handle(new Request("https://fixture.local", { method: "POST", headers: paypalHeaders, body: "{}" }))).status, 401);
  assert.equal(fixture.clients(), 0);
});
test("PayPal authentic foreign plans are acknowledged only after verification and never access billing", async () => {
  let providerCalls = 0;
  const fixture = load("paypal-webhook", paypalEnv, {}, async url => {
    providerCalls++;
    return new Response(JSON.stringify(String(url).endsWith("/token") ? { access_token: "fixture-token" } : { verification_status: "SUCCESS" }), { status: 200 });
  });
  const response = await fixture.handle(new Request("https://fixture.local", { method: "POST", headers: paypalHeaders,
    body: JSON.stringify({ id: "WH-foreign", event_type: "BILLING.SUBSCRIPTION.UPDATED", resource: { id: "I-foreign", plan_id: "P-other", status: "ACTIVE" } }) }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ignored: true });
  assert.equal(providerCalls, 2); assert.equal(fixture.clients(), 0);
});
test("A same-second billing conflict is acknowledged as pending reconciliation without claiming it applied", async () => {
  const fixture = load("lemonsqueezy-webhook", lemonEnv, { rpc: async () => ({ data: "ambiguous", error: null }) });
  const response = await fixture.handle(await signed(JSON.stringify(payload())));
  assert.equal(response.status, 202); assert.deepEqual(await response.json(), { result: "ambiguous" });
});
test("Push endpoint rejects anonymous calls and arbitrary event/recipient payloads", async () => {
  const fixture = load("send-push", { PUSH_HOOK_SECRET: "fixture-secret" });
  assert.equal((await fixture.handle(new Request("https://fixture.local", { method: "POST", body: "{}" }))).status, 401);
  const result = await fixture.handle(new Request("https://fixture.local", { method: "POST", headers: { "x-push-secret": "fixture-secret" }, body: JSON.stringify({ event: "request_message", id: uid, actor: uid }) }));
  assert.equal(result.status, 400); assert.equal(fixture.clients(), 0);
});
test("Receipt polling advances past older jobs whose push receipts already completed", async () => {
  const rows = [
    ...Array.from({ length: 51 }, (_, index) => ({ id: `done-${index}`, status: "sent", receipt_pending: false, completed_at: new Date().toISOString(), attempts: 1, deliveries: { [`push:old-${index}`]: { status: "delivered", channel: "push", userId: uid, ticketId: `done-${index}`, attemptedAt: new Date().toISOString() } } })),
    { id: "awaiting-receipt", status: "sent", receipt_pending: true, completed_at: new Date().toISOString(), attempts: 1, deliveries: { "push:pending-token": { status: "accepted", channel: "push", userId: uid, ticketId: "pending-ticket", attemptedAt: new Date().toISOString() } } },
  ];
  const updates: Record<string, unknown>[] = [];
  const received: string[][] = [];
  const fixture = load("send-push", { PUSH_HOOK_SECRET: "fixture-secret" }, {
    from: (table: string) => {
      assert.equal(table, "notification_outbox");
      let filtered = rows;
      let limit = Infinity;
      let update: Record<string, unknown> | undefined;
      const builder = {
        select: () => builder,
        update: (value: Record<string, unknown>) => { update = value; return builder; },
        eq: (key: string, value: unknown) => { if (!update) filtered = filtered.filter(row => (row as unknown as Record<string, unknown>)[key] === value); return builder; },
        gte: () => builder, order: () => builder,
        limit: (value: number) => { limit = value; return builder; },
        then: (resolve: (value: unknown) => unknown) => { if (update) updates.push(update); return Promise.resolve(resolve({ data: update ? null : filtered.slice(0, limit), error: null })); },
      };
      return builder;
    },
    rpc: async (name: string) => { assert.equal(name, "claim_notification_batch"); return { data: [], error: null }; },
  }, async (url, init) => {
    assert.equal(String(url), "https://exp.host/--/api/v2/push/getReceipts");
    received.push(JSON.parse(String(init?.body)).ids);
    return new Response(JSON.stringify({ data: { "pending-ticket": { status: "ok" } } }), { status: 200 });
  });
  const response = await fixture.handle(new Request("https://fixture.local", { method: "POST", headers: { "x-push-secret": "fixture-secret" }, body: "{}" }));
  assert.equal(response.status, 200);
  assert.deepEqual(received, [["pending-ticket"]]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].receipt_pending, false);
  assert.equal((updates[0].deliveries as Record<string, { status: string }>)["push:pending-token"].status, "delivered");
});
type DeletionRpcResult = { data?: unknown; error: { code?: string; message: string } | null };
function deletionAdmin(options: { billingBlocked?: boolean; uploadFailure?: boolean; neverEmpty?: boolean; claimState?: string; metadataFailure?: boolean; listFailure?: boolean; claimFailure?: boolean } = {}) {
  const calls: { name: string; args?: unknown }[] = [];
  let removed = false;
  return { calls, admin: {
    auth: { getUser: async () => ({ data: { user: { id: uid } }, error: null }), admin: { deleteUser: async (id: string) => { calls.push({ name: "deleteUser", args: id }); return { error: null }; }, signOut: async () => ({ error: null }) } },
    rpc: async (name: string, args: unknown): Promise<DeletionRpcResult> => {
      calls.push({ name, args });
      if (name === "prepare_identity_deletion") return { error: options.billingBlocked ? { code: "P0001", message: "fixture" } : null };
      if (name === "claim_identity_deletion_worker") return { data: options.claimState ?? "claimed", error: options.claimFailure ? { message: "Lost claim response" } : null };
      if (name === "owned_storage_paths") return { data: removed && !options.neverEmpty ? [] : [{ bucket_id: "attachments", name: `requests/${uid}/owned.jpg` }], error: options.listFailure ? { message: "Read failed" } : null };
      if (name === "forget_deleted_uploads") return { error: options.metadataFailure ? { message: "Metadata failed" } : null };
      return { data: true, error: null };
    },
    storage: { from: (bucket: string) => ({ remove: async (paths: string[]) => { calls.push({ name: "remove", args: { bucket, paths } }); removed = true; return { error: options.uploadFailure ? { message: "fixture storage failed" } : null }; } }) },
  } };
}
const deleteRequest = () => new Request("https://fixture.local", { method: "POST", headers: { Authorization: "Bearer fixture-jwt" }, body: JSON.stringify({ user_id: "attacker-selected-other-user" }) });
test("Deletion blocks ongoing billing before removing any data", async () => {
  const state = deletionAdmin({ billingBlocked: true }); const fixture = load("delete-account", {}, state.admin);
  const response = await fixture.handle(deleteRequest()); assert.equal(response.status, 409);
  assert.equal(state.calls.length, 1); assert.equal(state.calls[0].name, "prepare_identity_deletion");
});
test("Deletion removes server-owned paths before Auth and ignores supplied target user", async () => {
  const state = deletionAdmin(); const fixture = load("delete-account", {}, state.admin);
  const response = await fixture.handle(deleteRequest()); assert.equal(response.status, 200);
  assert.deepEqual(state.calls.map(call => call.name), ["prepare_identity_deletion", "claim_identity_deletion_worker", "owned_storage_paths", "begin_identity_deletion_step", "remove", "finish_identity_deletion_step", "forget_deleted_uploads", "owned_storage_paths", "prepare_identity_deletion", "begin_identity_deletion_step", "deleteUser"]);
  assert.equal(state.calls.at(-1)!.args, uid);
  for (const call of state.calls.filter(call => call.name === "owned_storage_paths" || call.name === "prepare_identity_deletion")) assert.equal((call.args as { p_owner_id: string }).p_owner_id, uid);
});
test("Unconfirmed Storage cleanup preserves account and blocks unsafe automatic retry", async () => {
  const state = deletionAdmin({ uploadFailure: true }); const fixture = load("delete-account", {}, state.admin);
  const response = await fixture.handle(deleteRequest());
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { pending: true, requiresReview: true, code: "deletion_review_required", error: "A deletion step has an unknown outcome. Contact support to reconcile it before continuing." });
  assert.equal(state.calls.some(call => call.name === "deleteUser"), false);
  assert.equal(state.calls.some(call => call.name === "forget_deleted_uploads"), false);
  assert.equal(state.calls.some(call => call.name === "mark_identity_deletion_uncertain"), true);
  assert.equal(state.calls.some(call => call.name === "release_identity_deletion_worker"), false);
});
test("Deletion rechecks renewed billing before deleting the identity", async () => {
  const state = deletionAdmin();
  const original = state.admin.rpc;
  let prepares = 0;
  state.admin.rpc = async (name, args) => name === "prepare_identity_deletion" && ++prepares > 1
    ? { error: { code: "P0001", message: "renewed during cleanup" } }
    : original(name, args);
  const response = await load("delete-account", {}, state.admin).handle(deleteRequest());
  assert.equal(response.status, 409);
  assert.equal(state.calls.some(call => call.name === "deleteUser"), false);
});
test("Cleanup in another bucket cannot remove attachment metadata with the same path", async () => {
  const state = deletionAdmin();
  const original = state.admin.rpc;
  state.admin.rpc = async (name, args) => {
    const result = await original(name, args);
    if (name === "owned_storage_paths" && "data" in result && Array.isArray(result.data) && result.data.length) return { data: [{ bucket_id: "private-other", name: `requests/${uid}/owned.jpg` }], error: null };
    return result;
  };
  assert.equal((await load("delete-account", {}, state.admin).handle(deleteRequest())).status, 200);
  assert.equal(state.calls.some(call => call.name === "forget_deleted_uploads"), false);
});
test("Concurrent deletion callers cannot list or remove paths held by an active worker", async () => {
  for (const claimState of ["running", "needs_review"]) {
    const state = deletionAdmin({ claimState });
    const response = await load("delete-account", {}, state.admin).handle(deleteRequest());
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, claimState === "running" ? "deletion_in_progress" : "deletion_review_required");
    assert.equal(body.requiresReview, claimState === "needs_review");
    assert.equal(state.calls.some(call => ["owned_storage_paths", "remove", "deleteUser", "release_identity_deletion_worker"].includes(call.name)), false);
  }
});
test("A second live handler cannot overtake a held Storage deletion", async () => {
  const state = deletionAdmin();
  const original = state.admin.rpc;
  let claimed = false;
  state.admin.rpc = async (name, args) => {
    if (name === "claim_identity_deletion_worker") {
      if (claimed) return { data: "running", error: null };
      claimed = true;
    }
    return original(name, args);
  };
  let enter!: () => void, complete!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { complete = resolve; });
  const storage = state.admin.storage.from;
  state.admin.storage.from = bucket => ({ remove: async paths => {
    enter(); await held;
    return storage(bucket).remove(paths);
  } });
  const fixture = load("delete-account", {}, state.admin);
  const first = fixture.handle(deleteRequest());
  await entered;
  const second = await fixture.handle(deleteRequest());
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, "deletion_in_progress");
  assert.equal(state.calls.filter(call => call.name === "owned_storage_paths").length, 1);
  complete();
  assert.equal((await first).status, 200);
  assert.equal(state.calls.filter(call => call.name === "remove").length, 1);
});
test("Acknowledged partial cleanup releases its claim before normal continuation", async () => {
  const state = deletionAdmin({ neverEmpty: true });
  const response = await load("delete-account", {}, state.admin).handle(deleteRequest());
  assert.equal(response.status, 202);
  assert.equal(state.calls.filter(call => call.name === "remove").length, 2000);
  assert.equal(state.calls.at(-1)?.name, "release_identity_deletion_worker");
  assert.equal(state.calls.some(call => call.name === "mark_identity_deletion_uncertain"), false);
});
test("Non-destructive read or metadata failures release only their own claim for retry", async () => {
  for (const options of [{ listFailure: true }, { metadataFailure: true }]) {
    const state = deletionAdmin(options);
    assert.equal((await load("delete-account", {}, state.admin).handle(deleteRequest())).status, 500);
    assert.equal(state.calls.at(-1)?.name, "release_identity_deletion_worker");
    const claimed = state.calls.find(call => call.name === "claim_identity_deletion_worker")?.args as { p_claim_token: string };
    const released = state.calls.at(-1)?.args as { p_claim_token: string };
    assert.equal(released.p_claim_token, claimed.p_claim_token);
    assert.equal(state.calls.some(call => call.name === "deleteUser"), false);
  }
});
test("A lost claim response cannot trigger path lookup or an unowned claim release", async () => {
  const state = deletionAdmin({ claimFailure: true });
  assert.equal((await load("delete-account", {}, state.admin).handle(deleteRequest())).status, 500);
  assert.equal(state.calls.some(call => ["owned_storage_paths", "remove", "release_identity_deletion_worker"].includes(call.name)), false);
});
test("Lost destructive-step acknowledgments retain the claim and stop further work", async () => {
  for (const failedRpc of ["begin_identity_deletion_step", "finish_identity_deletion_step"]) {
    const state = deletionAdmin();
    const original = state.admin.rpc;
    state.admin.rpc = async (name, args) => name === failedRpc
      ? { data: false, error: { message: "Lost step response" } }
      : original(name, args);
    const response = await load("delete-account", {}, state.admin).handle(deleteRequest());
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "deletion_review_required");
    assert.equal(state.calls.some(call => call.name === "release_identity_deletion_worker"), false);
    assert.equal(state.calls.some(call => call.name === "deleteUser"), false);
    if (failedRpc === "begin_identity_deletion_step") assert.equal(state.calls.some(call => call.name === "remove"), false);
  }
});
test("An ambiguous Auth delete keeps the worker claim blocked and reports review", async () => {
  const state = deletionAdmin();
  state.admin.auth.admin.deleteUser = async () => { throw new Error("Lost Auth response"); };
  const response = await load("delete-account", {}, state.admin).handle(deleteRequest());
  assert.equal(response.status, 409); assert.equal((await response.json()).code, "deletion_review_required");
  assert.equal(state.calls.at(-1)?.name, "mark_identity_deletion_uncertain");
  assert.equal(state.calls.some(call => call.name === "release_identity_deletion_worker"), false);
});
test("Reminder endpoint refuses invalid scheduler secret and non-POST calls", async () => {
  const fixture = load("send-reminders", { CRON_SECRET: "fixture-secret" });
  assert.equal((await fixture.handle(new Request("https://fixture.local", { method: "POST", headers: { "x-cron-secret": "wrong" } }))).status, 401);
  assert.equal((await fixture.handle(new Request("https://fixture.local"))).status, 405);
});
