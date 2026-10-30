import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as billing from "../supabase/functions/_shared/billing.ts";
import * as http from "../supabase/functions/_shared/http.ts";
import * as notifications from "../supabase/functions/_shared/notifications.ts";

const owner = "11111111-1111-4111-8111-111111111111", tenant = "22222222-2222-4222-8222-222222222222";
type Row = Record<string, any>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const job = (deliveries: unknown = {}) => ({ id: "job", event: "request_created", row_id: "request", actor_id: tenant, claim_token: "claim", attempts: 1, deliveries });
const accepted = (ticketId = "ticket") => ({ status: "accepted", channel: "push", userId: owner, ticketId, attemptedAt: new Date().toISOString() });
const request = () => new Request("http://fixture.local", { method: "POST", headers: { "x-push-secret": "fixture-secret" }, body: "{}" });
function fixture(options: { jobs?: Row[]; lostClaim?: boolean; receipts?: Row[]; tokens?: string[]; prefs?: Row; email?: Row; emailError?: Row; emailConfigured?: boolean; send?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
  const checkpoints: Row[] = [], finishes: Row[] = [], requests: string[] = [], deletes: Row[] = [];
  let handle!: (request: Request) => Promise<Response>;
  const admin = {
    from(table: string) {
      let update: Row | undefined, deleting = false;
      const filters: Row = {};
      const data = () => {
        if (table === "notification_outbox") return options.receipts ?? [];
        if (table === "maintenance_requests") return { id: "request", lease_id: "lease", title: "Repair", status: "new", owner_id: owner, tenant_user_id: tenant };
        if (table === "leases") return { id: "lease" };
        if (table === "notification_prefs") return options.prefs ?? { push_enabled: true, email_enabled: false };
        if (table === "push_tokens") return (options.tokens ?? []).map(token => ({ token }));
        throw new Error(`Unexpected table ${table}`);
      };
      const result = () => {
        if (update) { checkpoints.push(clone({ ...update, fixture_filters: filters })); return { data: options.lostClaim ? null : { id: filters.id }, error: null }; }
        if (deleting) { deletes.push(clone(filters)); return { data: null, error: null }; }
        return { data: data(), error: null };
      };
      const builder: any = { select: () => builder, update: (value: Row) => { update = value; return builder; }, delete: () => { deleting = true; return builder; }, eq: (key: string, value: unknown) => { filters[key] = value; return builder; }, order: () => builder, limit: () => builder, maybeSingle: async () => result(), then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(result())) };
      return builder;
    },
    rpc: async (name: string, args: Row) => {
      if (name === "claim_notification_batch") return { data: clone(options.jobs ?? []), error: null };
      assert.equal(name, "finish_notification"); finishes.push(clone(args)); return { data: true, error: null };
    },
    auth: { admin: { getUserById: async () => ({ data: { user: options.email ?? null }, error: options.emailError ?? null }) } },
  };
  const source = readFileSync(new URL("../supabase/functions/send-push/index.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const env: Row = { PUSH_HOOK_SECRET: "fixture-secret", ...(options.emailConfigured ? { RESEND_API_KEY: "fixture", NOTIFICATIONS_FROM: "fixture@example.test" } : {}) };
  runInNewContext(code, {
    exports: {}, Deno: { env: { get: (key: string) => env[key] }, serve: (fn: typeof handle) => { handle = fn; } },
    require: (name: string) => {
      if (name.startsWith("jsr:")) return { createClient: () => admin };
      if (name.endsWith("billing.ts")) return billing;
      if (name.endsWith("notifications.ts")) return notifications;
      if (name.endsWith("http.ts")) return { ...http, fetchWithTimeout: async (url: string, init: RequestInit) => { requests.push(url); assert.ok(checkpoints.length || url.endsWith("getReceipts"), "send intent persisted before provider access"); if (!options.send) throw new Error("Unexpected network"); return options.send(url, init); } };
      throw new Error(`Unexpected dependency ${name}`);
    },
    crypto, TextEncoder, TextDecoder, Request, Response, Headers, URL, Date, Map, Set, Promise,
    console: { error: () => undefined },
  });
  return { handle, checkpoints, finishes, requests, deletes };
}

test("An unreachable recipient fails terminally on the first attempt", async () => {
  const f = fixture({ jobs: [job()] });
  assert.equal((await f.handle(request())).status, 200);
  assert.equal(f.finishes[0].p_success, false); assert.equal(f.finishes[0].p_terminal, true);
  assert.equal(f.requests.length, 0);
});
test("No verified fallback address is terminal; missing provider configuration remains retryable", async () => {
  const unavailable = fixture({ jobs: [job()], prefs: { email_enabled: true }, emailConfigured: true });
  await unavailable.handle(request()); assert.equal(unavailable.finishes[0].p_terminal, true);
  const deleted = fixture({ jobs: [job()], prefs: { email_enabled: true }, emailError: { status: 404, code: "user_not_found" } });
  await deleted.handle(request()); assert.equal(deleted.finishes[0].p_terminal, true);
  const unconfigured = fixture({ jobs: [job()], prefs: { email_enabled: true }, email: { email: "fixture@example.test", email_confirmed_at: "2026-01-01" } });
  await unconfigured.handle(request()); assert.equal(unconfigured.finishes[0].p_terminal, false);
});
test("Failed receipt on attempt eight transitions to failed instead of unclaimable pending", async () => {
  const f = fixture({ receipts: [{ id: "job", attempts: 8, completed_at: new Date().toISOString(), deliveries: { "push:token": accepted() } }], send: async () => new Response(JSON.stringify({ data: { ticket: { status: "error", details: { error: "DeviceNotRegistered" } } } })) });
  assert.equal((await f.handle(request())).status, 200);
  assert.equal(f.checkpoints[0].status, "failed"); assert.equal(f.checkpoints[0].receipt_pending, false);
  assert.deepEqual(f.deletes, [{ token: "token", user_id: owner }]);
});
test("Unreported expired receipts become visible failures and do not send again", async () => {
  const f = fixture({ receipts: [{ id: "job", attempts: 1, completed_at: new Date(Date.now() - 25 * 3600_000).toISOString(), deliveries: { "push:token": accepted() } }] });
  await f.handle(request()); assert.equal(f.checkpoints[0].status, "failed");
  assert.equal(f.checkpoints[0].deliveries["push:token"].status, "uncertain"); assert.equal(f.requests.length, 0);
});
test("Lost acceptance is checkpointed and held for review across a worker retry", async () => {
  const first = fixture({ jobs: [job()], tokens: ["token"], send: async () => { throw new Error("response lost after acceptance"); } });
  await first.handle(request()); const finish = first.finishes[0];
  assert.equal(finish.p_terminal, true); assert.equal(finish.p_deliveries["push:token"].status, "uncertain");
  const retry = fixture({ jobs: [job(finish.p_deliveries)], tokens: ["token"] });
  await retry.handle(request()); assert.equal(retry.requests.length, 0); assert.equal(retry.finishes[0].p_terminal, true);
});
test("Partial acceptance preserves known tickets and never replays the accepted recipient", async () => {
  const first = fixture({ jobs: [job()], tokens: ["first", "second"], send: async () => new Response(JSON.stringify({ data: [{ status: "ok", id: "ticket" }] })) });
  await first.handle(request()); const finish = first.finishes[0];
  assert.equal(finish.p_deliveries["push:first"].status, "accepted"); assert.equal(finish.p_deliveries["push:second"].status, "uncertain");
  const retry = fixture({ jobs: [job(finish.p_deliveries)], tokens: ["first", "second"] });
  await retry.handle(request()); assert.equal(retry.requests.length, 0); assert.equal(retry.finishes[0].p_success, true);
});
test("Explicit rate limiting retries; permanent token errors do not resend", async () => {
  const limited = fixture({ jobs: [job()], tokens: ["token"], send: async () => new Response("rate limit", { status: 429 }) });
  await limited.handle(request()); assert.equal(limited.finishes[0].p_terminal, false);
  const dead = fixture({ jobs: [job()], tokens: ["token"], send: async () => new Response(JSON.stringify({ data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] })) });
  await dead.handle(request()); assert.equal(dead.finishes[0].p_terminal, true); assert.equal(dead.deletes.length, 1);
});
test("Provider server errors retain uncertain acceptance rather than duplicating a possible push", async () => {
  const f = fixture({ jobs: [job()], tokens: ["token"], send: async () => new Response("provider failure", { status: 503 }) });
  await f.handle(request()); assert.equal(f.finishes[0].p_terminal, true); assert.equal(f.finishes[0].p_deliveries["push:token"].status, "uncertain");
});

test("A worker that lost its claim cannot contact the push provider", async () => {
  const f = fixture({ jobs: [job()], tokens: ["token"], lostClaim: true });
  await f.handle(request()); assert.equal(f.requests.length, 0); assert.equal(f.finishes[0].p_success, false);
});

test("An old rate-limit failure does not retry a removed or disabled push channel", async () => {
  const previous = { "push:removed": { status: "failed", channel: "push", userId: owner, retryable: true, error: "Push service HTTP 429", attemptedAt: new Date().toISOString() } };
  const removed = fixture({ jobs: [job(previous)] });
  await removed.handle(request()); assert.equal(removed.finishes[0].p_terminal, true); assert.equal(removed.requests.length, 0);
  const disabled = fixture({ jobs: [job(previous)], tokens: ["removed"], prefs: { push_enabled: false, email_enabled: true } });
  await disabled.handle(request()); assert.equal(disabled.finishes[0].p_terminal, true); assert.equal(disabled.requests.length, 0);
});

test("A mixed final receipt clears polling and preserves unresolved tickets for review", async () => {
  const f = fixture({ receipts: [{ id: "job", attempts: 8, completed_at: new Date().toISOString(), deliveries: { "push:first": accepted("first-ticket"), "push:second": accepted("second-ticket") } }], send: async () => new Response(JSON.stringify({ data: { "first-ticket": { status: "error", details: { error: "DeviceNotRegistered" } } } })) });
  await f.handle(request()); assert.equal(f.checkpoints[0].status, "failed"); assert.equal(f.checkpoints[0].receipt_pending, false);
  assert.equal(f.checkpoints[0].deliveries["push:second"].status, "uncertain"); assert.equal(f.checkpoints[0].deliveries["push:second"].ticketId, "second-ticket");
});
