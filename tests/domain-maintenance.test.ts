import assert from "node:assert/strict";
import test from "node:test";
import { localToday, nextMaintenanceDate, partTotalsByCurrency, positiveNumber, validCalendarDate } from "../lib/maintenance";

test("calendar dates reject impossible dates rather than rolling into another month", () => {
  assert.equal(validCalendarDate("2026-02-29"), false);
  assert.equal(validCalendarDate("2024-02-29"), true);
  assert.equal(validCalendarDate("2026-04-31"), false);
  assert.equal(validCalendarDate("2026-1-01"), false);
  assert.equal(validCalendarDate("2026-10-26T12:00:00Z"), false);
});
test("monthly service clamps to the last day of a shorter month", () => {
  assert.equal(nextMaintenanceDate("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(nextMaintenanceDate("2024-01-31", "monthly"), "2024-02-29");
});
test("annual and quarterly service use calendar boundaries across leap years", () => {
  assert.equal(nextMaintenanceDate("2024-02-29", "annual"), "2025-02-28");
  assert.equal(nextMaintenanceDate("2026-11-30", "quarterly"), "2027-02-28");
  assert.equal(nextMaintenanceDate("2026-08-31", "biannual"), "2027-02-28");
});
test("day-based schedules cross year and daylight-saving boundaries as dates", () => {
  assert.equal(nextMaintenanceDate("2026-12-31", "daily"), "2027-01-01");
  assert.equal(nextMaintenanceDate("2026-03-06", "weekly"), "2026-03-13");
  assert.equal(nextMaintenanceDate("2026-01-01", "custom", 45), "2026-02-15");
});
test("custom intervals and invalid anchors are rejected", () => {
  for (const value of [0, -1, 1.5, Infinity, undefined, 36501]) assert.throws(() => nextMaintenanceDate("2026-01-01", "custom", value));
  assert.throws(() => nextMaintenanceDate("2026-02-30", "monthly"));
  assert.throws(() => nextMaintenanceDate("2026-01-01", "unknown"));
});
test("today uses the device calendar rather than UTC date", () => {
  const date = new Date(2026, 9, 26, 23, 59, 0);
  assert.equal(localToday(date), "2026-10-26");
});
test("quantity and cost validation does not accept silent numeric coercion", () => {
  for (const value of ["", " ", "NaN", "Infinity", "-1", "1e5", "1,50", "0.001", "abc", "0x10", "10000000000"]) assert.throws(() => positiveNumber(value, "Quantity"));
  assert.throws(() => positiveNumber("0", "Quantity"));
  assert.equal(positiveNumber("0", "Cost", true), 0);
  assert.equal(positiveNumber(" 2.50 ", "Quantity"), 2.5);
  assert.equal(positiveNumber(".5", "Quantity"), 0.5);
});
test("parts totals retain currency boundaries and zero-priced parts", () => {
  const result = partTotalsByCurrency([
    { quantity: 2, unit_cost: 5, cost_currency: "USD" },
    { quantity: 3, unit_cost: 7, cost_currency: "XCD" },
    { quantity: 2, unit_cost: 0, cost_currency: "XCD" },
    { quantity: 5, unit_cost: null, cost_currency: null },
  ], "USD");
  assert.deepEqual([...result.entries()], [["USD", 10], ["XCD", 21]]);
});
