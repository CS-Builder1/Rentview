import assert from "node:assert/strict";
import test from "node:test";
import { readAllPages } from "../lib/operationsQuery";
test("complete reads include the last page and request stable ranges", async () => {
  const source = Array.from({ length: 7 }, (_, id) => ({ id })), ranges: number[][] = [];
  const result = await readAllPages(async (from, to) => { ranges.push([from, to]); return { data: source.slice(from, to + 1), error: null }; }, 3, 30);
  assert.deepEqual(result.data, source); assert.deepEqual(ranges, [[0, 2], [3, 5], [6, 8]]);
});
test("later errors never expose a successful-looking partial result", async () => {
  const failure = { code: "42501", message: "Access denied" };
  const result = await readAllPages(async from => from === 0 ? { data: [1, 2], error: null } : { data: null, error: failure }, 2, 10);
  assert.equal(result.data, null); assert.equal(result.error, failure);
});
test("unexpected transport failures and unbounded results are surfaced", async () => {
  const failure = new Error("Network request failed");
  assert.equal((await readAllPages(async () => { throw failure; })).error, failure);
  assert.equal((await readAllPages(async () => ({ data: [1, 2, 3], error: null }), 2, 10)).data, null);
  assert.equal((await readAllPages(async () => ({ data: [1, 2], error: null }), 2, 4)).data, null);
});
test("a smaller API row cap does not truncate a counted result", async () => {
  const source = [1, 2, 3, 4, 5, 6, 7];
  const result = await readAllPages(async from => ({ data: source.slice(from, from + 2), error: null, count: 7 }), 3, 30);
  assert.deepEqual(result.data, source);
});
test("changing counts and missing pages never look like complete results", async () => {
  const changed = await readAllPages(async from => ({ data: [1, 2], error: null, count: from ? 5 : 4 }), 2, 10);
  assert.equal(changed.data, null);
  const missing = await readAllPages(async from => ({ data: from ? [] : [1, 2], error: null, count: 3 }), 2, 10);
  assert.equal(missing.data, null);
});
test("plain service errors retain their useful message", async () => {
  const { operationError } = await import("../lib/operationsQuery");
  assert.equal(operationError({ code: "23514", message: "Quantity must be greater than zero" }), "Quantity must be greater than zero");
  assert.equal(operationError(new Error("Offline")), "Offline");
  assert.equal(operationError({}), "The action could not be completed. Please retry.");
});
