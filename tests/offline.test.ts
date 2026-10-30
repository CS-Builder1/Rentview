import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createReadCache } from "../lib/cacheStore";
import { secureRecordId } from "../lib/id";
import {
  createOfflineStore, flushOfflineQueue, insertIdempotently, type OfflineTransport, type QueueStorage,
} from "../lib/offlineStore";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
class MemoryStorage implements QueueStorage {
  values = new Map<string, string>();
  rejectWrite = false;
  rejectRemove = false;
  async getItem(key: string) { await Promise.resolve(); return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) {
    await Promise.resolve();
    if (this.rejectWrite) throw new Error("Storage quota exceeded");
    this.values.set(key, value);
  }
  async removeItem(key: string) {
    if (this.rejectRemove) { this.rejectRemove = false; throw new Error("Device interrupted migration"); }
    this.values.delete(key);
  }
}
function backend() {
  const rows = new Map<string, Record<string, unknown>>();
  const uploads: string[] = [];
  let attempts = 0;
  let rejection: unknown = null;
  let loseAck = false;
  const transport: OfflineTransport = {
    async insert(table, payload) {
      attempts += 1;
      if (rejection) return { error: rejection };
      const key = `${table}:${payload.id}`;
      if (rows.has(key)) return { error: { code: "23505", message: "duplicate key" } };
      rows.set(key, structuredClone(payload));
      if (loseAck) { loseAck = false; return { error: new Error("Failed to fetch") }; }
      return { error: null };
    },
    async find(table, id) { return { data: rows.get(`${table}:${id}`) ?? null, error: null }; },
    async upload(photo) { uploads.push(photo.storagePath); },
    documentPayload(photo) {
      return { ...photo.doc, storage_path: photo.storagePath, mime_type: photo.contentType, size_bytes: 5 };
    },
  };
  return {
    transport, rows, uploads, get attempts() { return attempts; },
    reject(error: unknown) { rejection = error; }, loseNextAcknowledgment() { loseAck = true; },
  };
}

const expense = (accountId = A) => ({ owner_id: accountId, amount: 42, currency: "XCD", description: "Roof repair" });

test("record IDs use Expo's native generator or secure browser crypto without a weak fallback", () => {
  assert.equal(secureRecordId({ expo: { uuidv4: () => A } }), A);
  assert.equal(secureRecordId({ crypto: { randomUUID: () => B } }), B);
  const fromBytes = secureRecordId({ crypto: { getRandomValues: bytes => { bytes.fill(0xab); return bytes; } } });
  assert.equal(fromBytes, "abababab-abab-4bab-abab-abababababab");
  assert.throws(() => secureRecordId({}), /Secure saving is unavailable/);
  assert.throws(() => secureRecordId({ expo: { uuidv4: () => "weak-id" } }), /valid record ID/);
});

test("simultaneous captures and removal never overwrite another pending change", async () => {
  const store = createOfflineStore(new MemoryStorage(), randomUUID);
  const first = store.prepareInsert(A, "expenses", expense());
  await store.put(first);
  const changes = Array.from({ length: 60 }, () => store.prepareInsert(A, "expenses", expense()));
  await Promise.all([...changes.map((op) => store.put(op)), store.remove(A, first.id)]);
  const queue = await store.read(A);
  assert.equal(queue.length, 60);
  assert.equal(new Set(queue.map((op) => op.id)).size, 60);
});

test("separate store instances serialize through a shared browser-style lock", async () => {
  const storage = new MemoryStorage();
  let shared = Promise.resolve<unknown>(undefined);
  const exclusive = <T>(work: () => Promise<T>) => {
    const result = shared.then(work, work);
    shared = result.catch(() => undefined);
    return result;
  };
  const first = createOfflineStore(storage, randomUUID, Date.now, exclusive);
  const second = createOfflineStore(storage, randomUUID, Date.now, exclusive);
  await Promise.all(Array.from({ length: 40 }, (_, index) => {
    const store = index % 2 ? first : second;
    return store.put(store.prepareInsert(A, "expenses", expense()));
  }));
  assert.equal((await first.read(A)).length, 40);
});

test("account queues are separate and invalid ownership/table inputs are rejected", async () => {
  const store = createOfflineStore(new MemoryStorage(), randomUUID);
  await store.put(store.prepareInsert(A, "expenses", expense(A)));
  await store.put(store.prepareInsert(B, "expenses", expense(B)));
  assert.equal((await store.read(A))[0].accountId, A);
  assert.equal((await store.read(B))[0].accountId, B);
  assert.throws(() => store.prepareInsert(A, "expenses", expense(B)), /different account/);
  assert.throws(() => store.prepareInsert(A, "subscriptions", expense()), /requires a connection/);
  assert.throws(() => store.prepareInsert(A, "expenses", { ...expense(), amount: Number.NaN }), /valid number/);
});

test("a committed insert whose response is lost replays once with the same database ID", async () => {
  const store = createOfflineStore(new MemoryStorage(), randomUUID);
  const server = backend();
  const op = store.prepareInsert(A, "expenses", expense());
  await store.put(op);
  server.loseNextAcknowledgment();
  assert.equal(await flushOfflineQueue(store, server.transport, A, () => true), 0);
  assert.equal((await store.read(A))[0].status, "pending");
  assert.equal(server.rows.size, 1);
  assert.equal(await flushOfflineQueue(store, server.transport, A, () => true), 1);
  assert.equal(server.rows.size, 1);
  assert.equal(server.attempts, 2);
  assert.equal((await store.read(A)).length, 0);
});

test("permission and validation errors retain captured data until an explicit retry", async () => {
  for (const code of ["42501", "23514", "PGRST301", "500"]) {
    const store = createOfflineStore(new MemoryStorage(), randomUUID);
    const server = backend();
    const op = store.prepareInsert(A, "expenses", expense());
    await store.put(op);
    server.reject({ code, message: "Rejected safely" });
    assert.equal(await flushOfflineQueue(store, server.transport, A, () => true), 0);
    const failed = (await store.read(A))[0];
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.kind === "insert" && failed.payload, op.payload);
    await flushOfflineQueue(store, server.transport, A, () => true);
    assert.equal(server.attempts, 1, "failed entries must not spin in an automatic retry loop");
    server.reject(null);
    await store.retry(A, op.id);
    assert.equal(await flushOfflineQueue(store, server.transport, A, () => true), 1);
    assert.equal((await store.read(A)).length, 0);
  }
});

test("a unique conflict is accepted only when every submitted field matches the existing record", async () => {
  const store = createOfflineStore(new MemoryStorage(), randomUUID);
  const server = backend();
  const op = store.prepareInsert(A, "expenses", expense());
  server.rows.set(`expenses:${op.id}`, { ...op.payload, amount: 99 });
  await assert.rejects(insertIdempotently(server.transport, "expenses", op.payload), /conflicting record/);
  assert.equal(server.rows.get(`expenses:${op.id}`)?.amount, 99, "retry must never overwrite another result");
  server.rows.set(`expenses:${op.id}`, { ...op.payload, updated_at: "server-default" });
  await insertIdempotently(server.transport, "expenses", op.payload);
  const missing = backend();
  missing.reject({ code: "23505", message: "another unique constraint" });
  await assert.rejects(insertIdempotently(missing.transport, "expenses", op.payload), /conflicting record/);
});

test("sync cannot start before a matching authenticated session is ready", async () => {
  const store = createOfflineStore(new MemoryStorage(), randomUUID);
  const server = backend();
  await store.put(store.prepareInsert(A, "expenses", expense()));
  assert.equal(await flushOfflineQueue(store, server.transport, A, () => false), 0);
  assert.equal(server.attempts, 0);
  assert.equal((await store.read(A)).length, 1);
});

test("switching accounts during a response retains the original operation for safe later retry", async () => {
  const store = createOfflineStore(new MemoryStorage(), randomUUID);
  const server = backend();
  await store.put(store.prepareInsert(A, "expenses", expense()));
  let account = A;
  const insert = server.transport.insert;
  server.transport.insert = async (...args) => {
    const result = await insert(...args);
    account = B;
    return result;
  };
  assert.equal(await flushOfflineQueue(store, server.transport, A, () => account === A), 0);
  assert.equal((await store.read(A)).length, 1);
  assert.equal((await store.read(B)).length, 0);
  account = A;
  server.transport.insert = insert;
  assert.equal(await flushOfflineQueue(store, server.transport, A, () => account === A), 1);
  assert.equal(server.rows.size, 1);
});

test("photo retries reuse both the object path and document ID", async () => {
  const store = createOfflineStore(new MemoryStorage(), randomUUID);
  const server = backend();
  const op = store.preparePhoto(A, {
    base64: "aGVsbG8=", contentType: "image/jpeg", storagePath: `${A}/work_orders/roof/photo.jpg`,
    doc: { owner_id: A, name: "Roof photo", work_order_id: randomUUID() },
  });
  await store.put(op);
  server.loseNextAcknowledgment();
  await flushOfflineQueue(store, server.transport, A, () => true);
  await flushOfflineQueue(store, server.transport, A, () => true);
  assert.equal(server.rows.size, 1);
  assert.equal(new Set(server.uploads).size, 1);
  assert.equal(server.uploads.length, 2);
  assert.equal((await store.read(A)).length, 0);
  assert.equal(op.doc.id, op.id);
  assert.throws(() => store.preparePhoto(A, { ...op, storagePath: `${B}/other.jpg` }), /different account/);
  assert.throws(() => store.preparePhoto(A, { ...op, contentType: "image/svg+xml" }), /supported photo/);
});

test("editing protects identity and stale revisions cannot discard corrected content", async () => {
  const store = createOfflineStore(new MemoryStorage(), randomUUID);
  const op = store.prepareInsert(A, "expenses", expense());
  await store.put(op);
  await assert.rejects(store.edit(A, op.id, { ...op.payload, owner_id: B }), /cannot be changed/);
  await store.edit(A, op.id, { ...op.payload, amount: 24 });
  await store.remove(A, op.id, op.revision);
  const updated = (await store.read(A))[0];
  assert.equal(updated.kind === "insert" && updated.payload.amount, 24);
  assert.equal(updated.revision, 1);
  await store.remove(A, op.id, updated.revision);
  assert.equal((await store.read(A)).length, 0);
});

test("storage failures are explicit, and corrupt queues preserve their original bytes", async () => {
  const storage = new MemoryStorage();
  const store = createOfflineStore(storage, randomUUID);
  storage.rejectWrite = true;
  await assert.rejects(store.put(store.prepareInsert(A, "expenses", expense())), /quota/);
  storage.rejectWrite = false;
  const key = `rentview.offline.queue.v2.${A}`;
  storage.values.set(key, "not valid json");
  await assert.rejects(store.read(A), /preserved/);
  assert.equal(storage.values.get(key), "not valid json");
});

test("legacy recovery is account-scoped, requires review and survives interrupted migration", async () => {
  const storage = new MemoryStorage();
  storage.values.set("rentview.offline.queue.v1", JSON.stringify([
    { id: "old-a", table: "expenses", payload: expense(A), createdAt: 1 },
    { id: "old-b", table: "expenses", payload: expense(B), createdAt: 2 },
    { id: "unknown-owner", table: "expenses", payload: { amount: 12 } },
  ]));
  const store = createOfflineStore(storage, randomUUID);
  storage.rejectRemove = true;
  await assert.rejects(store.read(A), /interrupted migration/);
  const first = await store.read(A);
  const second = await store.read(B);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].status, "failed");
  assert.match(first[0].error ?? "", /older app version/);
  assert.equal(await store.hasQuarantinedChanges(), true);
  assert.equal(storage.values.has("rentview.offline.queue.v1"), false);
  const server = backend();
  await flushOfflineQueue(store, server.transport, A, () => true);
  assert.equal(server.attempts, 0, "legacy operations have no safe automatic duplicate detection");
});

test("cached reads distinguish fresh, stale and unavailable without mixing accounts", async () => {
  const cache = createReadCache(new MemoryStorage(), () => 123);
  cache.setAccount(A);
  const fresh = await cache.query<{ id: number }[]>("work", Promise.resolve({ data: [{ id: 1 }], error: null }));
  assert.equal(fresh.source, "network");
  const stale = await cache.query<{ id: number }[]>("work", Promise.resolve({ data: null, error: new Error("Failed to fetch") }));
  assert.deepEqual(stale.data, [{ id: 1 }]);
  assert.equal(stale.stale, true);
  assert.equal(stale.updatedAt, 123);
  assert.equal(cache.getNotices().length, 1);
  cache.setAccount(B);
  const absent = await cache.query("work", Promise.resolve({ data: null, error: new Error("Failed to fetch") }));
  assert.equal(absent.data, null);
  assert.equal(absent.source, "none");
  assert.equal(absent.stale, false);
});

test("permission failures discard sensitive cached fallback rather than hide revocation", async () => {
  const cache = createReadCache(new MemoryStorage());
  cache.setAccount(A);
  await cache.query("request:private", Promise.resolve({ data: { body: "private thread" }, error: null }));
  const denied = await cache.query("request:private", Promise.resolve({ data: null, error: { code: "42501", message: "denied" } }));
  assert.equal(denied.data, null);
  assert.equal(denied.stale, false);
  const later = await cache.query("request:private", Promise.resolve({ data: null, error: new Error("Failed to fetch") }));
  assert.equal(later.data, null);
});

test("RLS-hidden single rows invalidate cached details instead of restoring revoked access", async () => {
  const storage = new MemoryStorage();
  const cache = createReadCache(storage);
  cache.setAccount(A);
  await cache.query("request:hidden", Promise.resolve({ data: { body: "Private repair" }, error: null }));
  const hidden = await cache.query("request:hidden", Promise.resolve({ data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } }));
  assert.equal(hidden.data, null);
  assert.equal(hidden.stale, false);
  assert.equal(hidden.source, "none");
  assert.equal(await cache.get("request:hidden"), null);
  const offline = await cache.query("request:hidden", Promise.resolve({ data: null, error: new Error("Failed to fetch") }));
  assert.equal(offline.data, null);
});

test("an old account's in-flight result cannot populate or return the new account's cache", async () => {
  const storage = new MemoryStorage();
  const cache = createReadCache(storage);
  cache.setAccount(A);
  let finish!: (value: { data: unknown; error: unknown }) => void;
  const pending = cache.query("leases", new Promise((resolve) => { finish = resolve; }));
  cache.setAccount(B);
  finish({ data: [{ tenant_name: "Account A private" }], error: null });
  assert.equal((await pending).data, null);
  assert.equal(await cache.get("leases"), null);
  assert.equal(storage.values.size, 0);
});

test("a successful network read remains successful when disposable cache storage is full", async () => {
  const storage = new MemoryStorage();
  storage.rejectWrite = true;
  const cache = createReadCache(storage);
  cache.setAccount(A);
  const result = await cache.query("work", Promise.resolve({ data: [1], error: null }));
  assert.deepEqual(result.data, [1]);
  assert.equal(result.error, null);
  assert.equal(result.source, "network");
});

test("signing out and returning to the same account invalidates older in-flight results", async () => {
  const cache = createReadCache(new MemoryStorage());
  cache.setAccount(A);
  let finish!: (value: { data: unknown; error: unknown }) => void;
  const pending = cache.query("work", new Promise((resolve) => { finish = resolve; }));
  cache.setAccount(null);
  cache.setAccount(A);
  finish({ data: "old-session-data", error: null });
  assert.equal((await pending).data, null);
  assert.equal(await cache.get("work"), null);
});

test("signed-out cache queries do not execute a lazy authenticated builder", async () => {
  const cache = createReadCache(new MemoryStorage());
  let started = false;
  const result = await cache.query("private", {
    then(onfulfilled, onrejected) { started = true; return Promise.resolve({ data: "private", error: null }).then(onfulfilled, onrejected); },
  });
  assert.equal(started, false);
  assert.equal(result.data, null);
});

test("legacy quarantine never overwrites previously preserved recovery data", async () => {
  const storage = new MemoryStorage();
  storage.values.set("rentview.offline.quarantine.v2", "original unreadable quarantine");
  storage.values.set("rentview.offline.queue.v1", JSON.stringify([{ table: "expenses", payload: { amount: 5 } }]));
  const store = createOfflineStore(storage, randomUUID);
  await store.read(A);
  const recovered = JSON.parse(storage.values.get("rentview.offline.quarantine.v2")!);
  assert.equal(recovered[0].preservedRaw, "original unreadable quarantine");
  assert.equal(recovered.length, 2);
});

test("a caller-supplied record ID is persisted unchanged and malformed queued identity is rejected", async () => {
  const store = createOfflineStore(new MemoryStorage(), randomUUID);
  const id = randomUUID();
  const op = store.prepareInsert(A, "expenses", { ...expense(), id });
  assert.equal(op.id, id);
  assert.equal(op.payload.id, id);
  await assert.rejects(store.put({ ...op, id: randomUUID() }), /preserved/);
  assert.equal((await store.read(A)).length, 0);
});
