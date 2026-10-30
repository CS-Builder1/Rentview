import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/accountSession.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
type Snapshot = { access_token: string; refresh_token: string; expires_at?: number; user: { id: string } };
type ClientOptions = {
  global: { headers: Record<string, string>; fetch: typeof fetch };
  auth: { autoRefreshToken: boolean; persistSession: boolean; detectSessionInUrl: boolean; storageKey: string };
};
function fixture(env: Record<string, string> = {
  EXPO_PUBLIC_SUPABASE_URL: "https://fixture.local",
  EXPO_PUBLIC_SUPABASE_ANON_KEY: "fixture-publishable-key",
}) {
  const calls: { url: string; key: string; options: ClientOptions }[] = [];
  const network: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const exports: { createAccountSession?: (snapshot: Snapshot) => unknown } = {};
  const client = { marker: "isolated fixture client" };
  runInNewContext(compiled, {
    exports, process: { env }, Date, URL, Headers, Request, Response, Promise,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      network.push({ input, init });
      return new Response("{}", { status: 200 });
    },
    require: (name: string) => {
      assert.equal(name, "@supabase/supabase-js");
      return { createClient: (url: string, key: string, options: ClientOptions) => {
        calls.push({ url, key, options }); return client;
      } };
    },
  });
  assert.ok(exports.createAccountSession);
  return { create: exports.createAccountSession, calls, network, client };
}
function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { access_token: "fixture-bearer-a", refresh_token: "fixture-refresh-a", expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: "owner-a" }, ...overrides };
}

test("captured account clients disable persistent/shared auth and bind every request to the initiating bearer", async () => {
  const f = fixture();
  const initiatingSession = snapshot();
  assert.equal(f.create(initiatingSession), f.client);
  // SDK or application mutation of the old session object cannot retarget this client.
  initiatingSession.access_token = "fixture-newer-user-b";
  initiatingSession.user.id = "owner-b";
  assert.equal(f.calls.length, 1);
  const { url, key, options } = f.calls[0];
  assert.equal(url, "https://fixture.local");
  assert.equal(key, "fixture-publishable-key");
  assert.equal(options.auth.autoRefreshToken, false);
  assert.equal(options.auth.persistSession, false);
  assert.equal(options.auth.detectSessionInUrl, false);
  assert.equal(options.auth.storageKey, "rentview.account-action.owner-a");
  assert.equal(options.global.headers.Authorization, "Bearer fixture-bearer-a");
  for (const [path, method] of [["/rest/v1/profiles", "PATCH"], ["/auth/v1/user", "PUT"], ["/auth/v1/logout?scope=others", "POST"], ["/functions/v1/delete-account", "POST"]]) {
    await options.global.fetch(`https://fixture.local${path}`, { method, headers: { Authorization: "Bearer fixture-newer-user-b", apikey: "fixture-key" } });
    const sent = new Headers(f.network.at(-1)?.init?.headers);
    assert.equal(sent.get("Authorization"), "Bearer fixture-bearer-a");
    assert.equal(sent.get("apikey"), "fixture-key");
  }
});

test("temporary clients refuse token rotation for all methods and normalized token endpoint paths", async () => {
  const f = fixture(); f.create(snapshot());
  const transport = f.calls[0].options.global.fetch;
  for (const path of ["/auth/v1/token", "/auth//v1/token/", "/auth/v1/%74oken", "/auth/v1/./token", "/auth/v1/nested/../token", "/auth/v1/%2574oken"]) {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const result = await transport(`https://fixture.local${path}?grant_type=refresh_token`, { method });
      assert.equal(result.status, 401);
      assert.equal((await result.json()).code, "account_snapshot_expired");
    }
  }
  assert.equal(f.network.length, 0);
});

test("Request/URL inputs retain captured authorization and never send credentials to another origin", async () => {
  const f = fixture(); f.create(snapshot());
  const transport = f.calls[0].options.global.fetch;
  await transport(new Request("https://fixture.local/auth/v1/user", { headers: { Authorization: "Bearer other-user" } }));
  assert.equal(new Headers(f.network[0].init?.headers).get("Authorization"), "Bearer fixture-bearer-a");
  await transport(new URL("https://fixture.local/rest/v1/profiles"));
  assert.equal(new Headers(f.network[1].init?.headers).get("Authorization"), "Bearer fixture-bearer-a");
  assert.throws(() => transport("https://elsewhere.invalid/auth/v1/user"), /configured account service/);
  assert.equal(f.network.length, 2);
});

test("missing or expired account snapshots fail before constructing any SDK client", () => {
  const f = fixture();
  assert.throws(() => f.create(snapshot({ expires_at: Math.floor(Date.now() / 1000) - 1 })), /session expired/);
  assert.throws(() => f.create(snapshot({ access_token: "" })), /session is unavailable/);
  assert.throws(() => f.create(snapshot({ refresh_token: "" })), /session is unavailable/);
  assert.equal(f.calls.length, 0);
  const absent = fixture({});
  assert.throws(() => absent.create(snapshot()), /unavailable in this build/);
  assert.equal(absent.calls.length, 0);
});
