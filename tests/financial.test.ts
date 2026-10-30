import assert from "node:assert/strict";
import test from "node:test";
import { formatDate } from "../lib/format";
import { totalsByCurrency, requiredCount } from "../lib/dashboard";
import { escapeCell, toCsv, decimalCell } from "../lib/csvCore";
import { grantsPro } from "../lib/entitlements";
import { currencyCode, calendarDate, nonNegativeMoney } from "../lib/validation";

test("calendar dates retain their day in negative and positive UTC offsets", () => {
  const original = process.env.TZ;
  try {
    for (const zone of ["America/St_Lucia", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      process.env.TZ = zone;
      assert.match(formatDate("2026-10-26"), /26/);
      assert.equal(formatDate("2026-02-30"), "—");
    }
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});
test("money remains separated by currency with exact cent addition", () => {
  assert.deepEqual(totalsByCurrency([{ currency: "USD", amount: 0.1 }, { currency: "USD", amount: 0.2 }, { currency: "XCD", amount: 100 }]), { USD: 0.3, XCD: 100 });
  assert.throws(() => totalsByCurrency([{ currency: "USD", amount: Infinity }]));
  assert.throws(() => totalsByCurrency([{ currency: "__proto__", amount: 1 }]));
  assert.throws(() => totalsByCurrency([{ currency: "USD", amount: Number.MAX_VALUE }]));
});
test("valid large receipts sum to the exact cent and unrepresentable aggregates fail closed", () => {
  const maximumReceipt = { currency: "GBP", amount: 9999999999.99 };
  assert.deepEqual(totalsByCurrency([
    ...Array.from({ length: 249 }, () => maximumReceipt),
    { currency: "USD", amount: 0.1 }, { currency: "USD", amount: 0.2 },
    { currency: "XCD", amount: 100 },
  ]), { GBP: 2489999999997.51, USD: 0.3, XCD: 100 });
  assert.throws(() => totalsByCurrency(Array.from({ length: 9007 }, () => maximumReceipt)), /supported precision/);
  assert.throws(() => totalsByCurrency(Array.from({ length: 9008 }, () => maximumReceipt)), /supported precision/);
  // A numeric multiply/round trip passes for this safe cent total even though
  // fixed-decimal export rounds it to the wrong cent.
  assert.throws(() => totalsByCurrency([
    ...Array.from({ length: 9007 }, () => maximumReceipt),
    { currency: "GBP", amount: 1992547499.69 },
  ]), /supported precision/);
});
test("a failed or absent dashboard count never becomes an all-clear zero", () => {
  assert.equal(requiredCount({ count: 0, error: null }), 0);
  assert.throws(() => requiredCount({ count: null, error: null }));
  assert.throws(() => requiredCount({ count: 0, error: { message: "backend unavailable" } }));
});
test("CSV escapes data and neutralizes spreadsheet formula injection", () => {
  for (const input of ["=1+1", "+cmd", "-cmd", "@SUM(A1)", " \t=HYPERLINK(\"bad\")", "\tformula"]) assert.match(escapeCell(input), /^"?'/);
  assert.equal(escapeCell(-12), "-12");
  assert.equal(escapeCell('hello, "world"'), '"hello, ""world"""');
  assert.equal(toCsv(["Amount"], [[12], [null]]), "Amount\r\n12\r\n");
});
test("explicit CSV amounts retain numeric negative cents while arbitrary text stays escaped", () => {
  assert.equal(toCsv(["Amount", "Description"], [[decimalCell(-12.34), "-12.34"], [decimalCell(0), "=1+1"]]),
    "Amount,Description\r\n-12.34,'-12.34\r\n0.00,'=1+1");
  for (const invalid of [NaN, Infinity, 12.345, 1e21]) assert.throws(() => decimalCell(invalid));
});
test("legacy or self-written paid states never grant verified entitlement", () => {
  const base = { plan: "pro", status: "active", current_period_end: null, billing_verified_at: null };
  assert.equal(grantsPro(base), false);
  assert.equal(grantsPro({ ...base, billing_verified_at: "invalid" }), false);
  assert.equal(grantsPro({ ...base, billing_verified_at: "2026-10-01T00:00:00Z" }), true);
  assert.equal(grantsPro({ ...base, billing_verified_at: "2026-10-01T00:00:00Z", status: "cancelled", current_period_end: "2026-10-28T00:00:00Z" }, Date.parse("2026-10-28T00:00:00Z")), false);
});
test("owner financial fields reject invalid dates, amounts and currency syntax", () => {
  assert.equal(currencyCode(" xcd "), "XCD");
  assert.throws(() => currencyCode("USDD"));
  assert.throws(() => calendarDate("2026-02-29"));
  assert.equal(calendarDate("", "Date", true), null);
  for (const amount of ["NaN", "Infinity", "-1", "1e3", "1.001", ""]) assert.throws(() => nonNegativeMoney(amount, "Amount"));
  assert.equal(nonNegativeMoney("12.34", "Amount"), 12.34);
});
