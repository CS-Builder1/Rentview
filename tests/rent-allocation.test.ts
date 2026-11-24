import assert from "node:assert/strict";
import test from "node:test";
import { rentSummaries, rentState } from "../lib/tenantRent";

test("receipts reduce only their allocated charges and preserve legacy history", () => {
  const charge = { lease_id: "a", amount: 1000, currency: "USD", due_date: "2026-01-01", paid_on: null, applied_amount: 400 };
  const records = [charge, { ...charge, amount: 100, applied_amount: 50 }, { ...charge, lease_id: "b", currency: "EUR", amount: 30, applied_amount: 0 },
    { ...charge, amount: 450, applied_amount: 450, paid_on: "2026-01-02" }, { ...charge, amount: 50, paid_on: "2026-01-03", applied_amount: 0 }];
  assert.deepEqual(rentSummaries(records, "2026-01-04").map(r => [r.leaseId, r.currency, r.overdue]), [["a", "USD", 650], ["b", "EUR", 30]]);
  assert.equal(rentState({ ...charge, applied_amount: 1000 }), "paid");
});

import { operatingStatement, type StatementEntry } from "../lib/operatingReport";

test("operating statements use the receipt date, include each receipt once and total each currency separately", () => {
  const base: StatementEntry = { date: "2026-05-01", property: "A", unit: "1", label: "", vendor: "", type: "Rent received", amount: 400, currency: "USD" };
  const csv = operatingStatement([base,{ ...base, date:"2026-04-29",type:"Expense incurred",amount:25.10 },{ ...base, type:"Expense incurred",amount:60,currency:"XCD" }]);
  assert.ok(csv.indexOf("2026-04-29") < csv.indexOf("2026-05-01"));
  assert.match(csv,/Rent less expenses,,,374.90,USD/);
  assert.match(csv,/Rent less expenses,,,-60.00,XCD/);
});
