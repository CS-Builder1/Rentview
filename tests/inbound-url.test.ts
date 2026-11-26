import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeInboundUrlQuery } from "../lib/inboundUrl.ts";
import { installInboundWebUrlSanitizer } from "../lib/inboundWeb.ts";
import { redirectSystemPath } from "../app/+native-intent.tsx";

test("inbound URLs remove all Object.prototype query member names, including escaped names", () => {
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    const escaped = Array.from(name, character => `%${character.charCodeAt(0).toString(16)}`).join("");
    for (const key of [name, escaped]) {
      assert.equal(sanitizeInboundUrlQuery(`/login?${key}=harmless&next=%2F`), "/login?next=%2F", name);
    }
  }
  assert.equal(sanitizeInboundUrlQuery("/login?toString=x&toString=y&valueOf=z#retained"), "/login#retained");
});

test("web initial and back/forward URLs are sanitized while preserving history state", () => {
  const state = { key: "existing-router-state", index: 4 };
  const location = { href: "https://rentview.invalid/login?toString=harmless&next=%2F" };
  const listeners: (() => void)[] = [];
  const replacements: string[] = [];
  installInboundWebUrlSanitizer({
    location,
    history: {
      state,
      replaceState(data, title, url) {
        assert.strictEqual(data, state);
        assert.equal(title, "");
        replacements.push(url);
        location.href = url;
      },
    },
    addEventListener(type, listener, capture) {
      assert.equal(type, "popstate");
      assert.equal(capture, true);
      assert.equal(location.href, "https://rentview.invalid/login?next=%2F");
      listeners.push(listener);
    },
  });
  assert.equal(replacements.length, 1);
  location.href = "https://rentview.invalid/callback?code=AbC%2B%3D&valueOf=harmless#fragment";
  listeners[0]();
  assert.equal(location.href, "https://rentview.invalid/callback?code=AbC%2B%3D#fragment");
  listeners[0]();
  assert.equal(replacements.length, 2, "unchanged URLs do not replace history again");
});

test("native initial and subsequent deep links preserve callback syntax while removing reserved keys", () => {
  for (const initial of [true, false]) {
    assert.equal(
      redirectSystemPath({ path: "rentview://callback?code=AbC%2F%2B%3D&toString=harmless&intent=recovery#retained", initial }),
      "rentview://callback?code=AbC%2F%2B%3D&intent=recovery#retained",
    );
    assert.equal(redirectSystemPath({ path: "/claim?code=ABC123", initial }), "/claim?code=ABC123");
  }
});

test("inbound sanitization preserves callback, invitation, duplicate and malformed URL bytes", () => {
  const unchanged = [
    "/login?next=%&note=%2&escape=%GG",
    "/login?next=%E0%A4%A&note=%ED%A0%80",
    "/login?note=%F0%9F%98%80&note=caf%C3%A9",
    "/login?next=%2Fclaim%3Fcode%3DABC123&next=%2Faccount",
    "/callback?code=AbC%2F%2B%3D&next=%2Fclaim%3Fcode%3DABC123#fragment%20bytes",
    "rentview://callback?code=AbC%2F%2B%3D&intent=recovery",
    "exp://127.0.0.1:8081/--/claim?code=ABC123",
    "/claim?code=ABC123&constructor%5Bprototype%5D%5Bpolluted%5D=true",
    "/login?ToString=case-sensitive&toStringExtra=retained&%2574oString=literal",
    "/callback#toString=fragment-is-not-query",
    "/login?note=" + "x".repeat(3800),
  ];
  for (const value of unchanged) assert.equal(sanitizeInboundUrlQuery(value), value);
  assert.equal(
    sanitizeInboundUrlQuery("rentview://callback?code=AbC%2F%2B%3D&toString=x&intent=recovery#retained"),
    "rentview://callback?code=AbC%2F%2B%3D&intent=recovery#retained",
  );
});
