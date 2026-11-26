import test from "node:test";
import assert from "node:assert/strict";
import { disposableDatabaseTarget } from "../scripts/db-target.mjs";

test("database target validation refuses missing disposable opt-in", () => {
  assert.throws(() => disposableDatabaseTarget(undefined, undefined), /No database was contacted/);
  assert.throws(() => disposableDatabaseTarget("postgresql://fixture:dummy@localhost/db", "0"), /No database was contacted/);
});
test("database target validation refuses remote hosts and connection overrides", () => {
  for (const url of ["postgresql://fixture:dummy@production.example.test/db", "postgresql://fixture:dummy@127.0.0.1/db?host=remote.example.test", "postgresql://localhost/db#override", "https://localhost/db"]) assert.throws(() => disposableDatabaseTarget(url, "1"), /Refusing a non-loopback/);
  assert.equal(disposableDatabaseTarget("postgresql://fixture:dummy@127.0.0.1:54322/postgres", "1"), "postgresql://fixture:dummy@127.0.0.1:54322/postgres");
});
