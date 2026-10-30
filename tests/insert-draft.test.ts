import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createInsertDraft, insertDraftIdentity } from "../lib/insertDraft";
import { createOfflineStore, flushOfflineQueue, type OfflineTransport, type QueueStorage } from "../lib/offlineStore";
import { editedSavedChange } from "../lib/savedChangeEdit";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
class Storage implements QueueStorage {
  entries = new Map<string, string>();
  async getItem(key: string) { return this.entries.get(key) ?? null; }
  async setItem(key: string, value: string) { this.entries.set(key, value); }
  async removeItem(key: string) { this.entries.delete(key); }
}

for (const table of ["work_orders", "assets", "leases"] as const) {
  test(`${table}: rejected save, repeated form save and explicit retry retain one intent`, async () => {
    const store = createOfflineStore(new Storage(), randomUUID);
    let identities = 0;
    const draft = createInsertDraft(A, () => { identities++; return randomUUID(); });
    const identity = insertDraftIdentity(draft, A, [], table);
    const operation = store.prepareInsert(A, table, { ...identity, name: "First intent" });
    await store.put(operation);
    let fail = true;
    const rows = new Map<string, Record<string, unknown>>();
    const transport: OfflineTransport = {
      async insert(_table, payload) {
        if (fail) return { error: { code: "23514", message: "Invalid details" } };
        rows.set(String(payload.id), payload);
        return { error: null };
      },
      async find(_table, id) { return { data: rows.get(id) ?? null, error: null }; },
      async upload() { throw new Error("Unexpected upload"); },
      documentPayload() { throw new Error("Unexpected photo"); },
    };
    await flushOfflineQueue(store, transport, A, () => true);
    const failed = await store.read(A);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].status, "failed");
    assert.throws(() => insertDraftIdentity(draft, A, failed, table), /already saved/);
    // Even a stale UI queue snapshot cannot overwrite/fork the durable payload.
    await assert.rejects(store.put(store.prepareInsert(A, table, { ...insertDraftIdentity(draft, A, [], table), name: "Edited in original form" })), /already waiting/);
    assert.equal(identities, 1);
    await store.edit(A, identity.id, { ...identity, name: "Corrected in Saved changes" });
    fail = false;
    await flushOfflineQueue(store, transport, A, () => true);
    assert.equal(rows.size, 1);
    assert.equal(rows.get(identity.id)?.name, "Corrected in Saved changes");
    assert.deepEqual(await store.read(A), []);
    assert.equal(insertDraftIdentity(draft, A, [], table).id, identity.id);
  });
}

test("an opened draft cannot transfer to a newly signed-in account", () => {
  const draft = createInsertDraft(A, randomUUID);
  assert.throws(() => insertDraftIdentity(draft, B, [], "lease"), /different signed-in account/);
  assert.throws(() => insertDraftIdentity(null, B, [], "asset"), /no longer active/);
  assert.equal(insertDraftIdentity(draft, A, [], "work order").owner_id, A);
  assert.notEqual(createInsertDraft(A, randomUUID).id, draft.id);
});

test("optional blank saved money stays null and does not block unrelated edits", () => {
  const original = { id: "same-id", owner_id: A, rent_amount: null, deposit_amount: null, tenant_name: "Old" };
  const edited = editedSavedChange("leases", original, { rent_amount: "", deposit_amount: " ", tenant_name: "Corrected" });
  assert.equal(edited.rent_amount, null);
  assert.equal(edited.deposit_amount, null);
  assert.equal(edited.tenant_name, "Corrected");
  assert.equal(edited.id, original.id);
  assert.equal(edited.owner_id, A);
  assert.equal(editedSavedChange("assets", { purchase_cost: null }, { purchase_cost: "" }).purchase_cost, null);
  assert.equal(editedSavedChange("assets", { purchase_currency: null }, { purchase_currency: "" }).purchase_currency, null);
  assert.throws(() => editedSavedChange("expenses", { currency: "USD" }, { currency: "" }), /currency code/);
  assert.throws(() => editedSavedChange("expenses", { amount: 1 }, { amount: "" }), /valid amount/);
});

test("saved monetary corrections use the same decimal validation as their forms", () => {
  for (const key of ["amount", "rent_amount", "purchase_cost", "deposit_amount"]) {
    for (const invalid of ["12.345", "NaN", "Infinity", "1e3", "-1", "0x10"]) {
      assert.throws(() => editedSavedChange("leases", {}, { [key]: invalid }), /valid amount/);
    }
    assert.equal(editedSavedChange("leases", {}, { [key]: " 12.34 " })[key], 12.34);
    assert.equal(editedSavedChange("leases", {}, { [key]: "0" })[key], 0);
  }
});

test("saved calendar corrections reject invalid or required blank dates", () => {
  assert.equal(editedSavedChange("leases", {}, { end_date: "" }).end_date, null);
  assert.throws(() => editedSavedChange("expenses", {}, { incurred_on: "" }), /valid date/);
  assert.throws(() => editedSavedChange("leases", {}, { start_date: "2026-02-30" }), /valid date/);
  assert.throws(() => editedSavedChange("leases", { start_date: "2026-04-01" }, { end_date: "2026-03-01" }), /before the start/);
});
