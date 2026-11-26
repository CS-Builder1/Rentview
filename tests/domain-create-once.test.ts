import assert from "node:assert/strict";
import test from "node:test";
import { createOnce } from "../lib/createOnce";
const row = { id: "fixture-id", owner_id: "fixture-owner", amount: 42, currency: "XCD" };
test("a create returns only its expected database identity", async () => {
  assert.deepEqual(await createOnce(row, async () => ({ data: { id: row.id }, error: null }), async () => { throw new Error("Unexpected read"); }), { id: row.id });
  await assert.rejects(createOnce(row, async () => ({ data: { id: "different" }, error: null }), async () => { throw new Error("Unexpected read"); }));
});
test("a committed create with lost acknowledgment is confirmed by all submitted fields", async () => {
  let server: typeof row | null = null;
  const insert = async () => { server = { ...row }; throw new Error("Failed to fetch"); };
  const inspect = async () => ({ data: server, error: null });
  assert.deepEqual(await createOnce(row, insert, inspect), { id: row.id });
  assert.deepEqual(await createOnce(row, async () => ({ data: null, error: { code: "23505" } }), inspect), { id: row.id });
});
test("a duplicate ID never overwrites or confirms different ownership or money", async () => {
  for (const changes of [{ owner_id: "another-account" }, { amount: 43 }, { currency: "USD" }]) {
    await assert.rejects(createOnce(row, async () => ({ data: null, error: { code: "23505" } }), async () => ({ data: { ...row, ...changes }, error: null })), /different details/);
  }
});
test("an unavailable or forbidden verification keeps the failure visible", async () => {
  const error = { code: "23505", message: "Unique violation" };
  await assert.rejects(createOnce(row, async () => ({ data: null, error }), async () => ({ data: null, error: { code: "42501" } })), e => e === error);
  const invalid = { code: "23514", message: "Invalid amount" };
  await assert.rejects(createOnce(row, async () => ({ data: null, error: invalid }), async () => { throw new Error("Unexpected read"); }), e => e === invalid);
});
