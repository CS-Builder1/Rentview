import assert from "node:assert/strict";
import test from "node:test";
import { accountActionGuard, canNavigateAfterSignOut } from "../lib/accountActionState";

test("an account action stops before a second write if the account changes during an await", async () => {
  let current: string | null = "owner-a";
  const guard = accountActionGuard("owner-a", () => current);
  const writes: string[] = [];
  guard(); writes.push("profile owner-a");
  await Promise.resolve(); current = "owner-b";
  assert.throws(() => { guard(); writes.push("email owner-b"); }, /account changed/);
  assert.deepEqual(writes, ["profile owner-a"]);
  current = null; assert.throws(guard, /account changed/);
});

test("deletion completion cannot navigate a newly signed-in account away", () => {
  assert.equal(canNavigateAfterSignOut("owner-a", "owner-a"), true);
  assert.equal(canNavigateAfterSignOut("owner-a", null), true);
  assert.equal(canNavigateAfterSignOut("owner-a", undefined), true);
  assert.equal(canNavigateAfterSignOut("owner-a", "owner-b"), false);
});
