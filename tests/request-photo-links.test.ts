import assert from "node:assert/strict";
import test from "node:test";
import { createRequestPhotoLinks } from "../lib/requestPhotoLinks";

const photos = [
  { id: "good", storage_path: "requests/request-a/good.jpg" },
  { id: "missing", storage_path: "requests/request-a/missing.jpg" },
];

test("an unavailable repair photo does not prevent the other photos resolving", async () => {
  const links = createRequestPhotoLinks(() => 0);
  const result = await links.resolve(photos, async path => {
    if (path.endsWith("missing.jpg")) throw new Error("Object not found");
    return "https://fixture.local/short-lived-good";
  });
  assert.deepEqual(result, [
    { id: "good", url: "https://fixture.local/short-lived-good" },
    { id: "missing", url: null },
  ]);
});

test("polling reuses healthy short-lived links and refreshes before their expiry", async () => {
  let now = 0;
  const links = createRequestPhotoLinks(() => now);
  const calls: number[] = [];
  const sign = async (_: string, seconds: number) => { calls.push(seconds); return `link-${calls.length}`; };
  for (now of [0, 12_000, 24_000, 36_000]) {
    assert.deepEqual(await links.resolve([photos[0]], sign), [{ id: "good", url: "link-1" }]);
  }
  assert.deepEqual(calls, [60]);
  now = 48_000;
  assert.deepEqual(await links.resolve([photos[0]], sign), [{ id: "good", url: "link-2" }]);
  assert.deepEqual(calls, [60, 60]);
});

test("unavailable photos have bounded automatic retries and an immediate explicit retry", async () => {
  let now = 0, calls = 0;
  const links = createRequestPhotoLinks(() => now);
  const sign = async () => { calls++; return calls < 3 ? null : "recovered"; };
  await links.resolve([photos[1]], sign);
  now = 12_000; await links.resolve([photos[1]], sign);
  assert.equal(calls, 1);
  now = 36_000; await links.resolve([photos[1]], sign);
  assert.equal(calls, 2);
  links.retryUnavailable();
  assert.deepEqual(await links.resolve([photos[1]], sign), [{ id: "missing", url: "recovered" }]);
  assert.equal(calls, 3);
});

test("removed records and changed object paths cannot reuse an obsolete link", async () => {
  const links = createRequestPhotoLinks(() => 0);
  let calls = 0;
  const sign = async (path: string) => { calls++; return path; };
  await links.resolve([photos[0]], sign);
  const replacement = { ...photos[0], storage_path: "requests/request-a/replacement.jpg" };
  assert.deepEqual(await links.resolve([replacement], sign), [{ id: "good", url: replacement.storage_path }]);
  await links.resolve([], sign);
  await links.resolve([replacement], sign);
  assert.equal(calls, 3);
});

test("an old account/request's delayed signer cannot populate a new lifetime's cache", async () => {
  const previous = createRequestPhotoLinks(() => 0);
  let finish!: (url: string) => void;
  const delayed = previous.resolve([photos[0]], () => new Promise(resolve => { finish = resolve; }));
  const current = createRequestPhotoLinks(() => 0);
  let calls = 0;
  const fresh = await current.resolve([photos[0]], async () => { calls++; return "current-account-link"; });
  finish("old-account-link"); await delayed;
  assert.deepEqual(await current.resolve([photos[0]], async () => { throw new Error("Should use current link"); }), fresh);
  assert.equal(calls, 1);
});

test("slow signing cannot make an expired URL look fresh for another minute", async () => {
  let now = 0, calls = 0;
  const links = createRequestPhotoLinks(() => now);
  const sign = async () => { calls++; now += 50_000; return `link-${calls}`; };
  await links.resolve([photos[0]], sign);
  await links.resolve([photos[0]], sign);
  assert.equal(calls, 2);
});
