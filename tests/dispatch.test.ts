import assert from "node:assert/strict";
import test from "node:test";
import { visitWindow } from "../lib/dispatchVisit";
import { authDestination, safeReturnPath } from "../lib/invites";

test("contractor invitation and job destinations survive the sign-in redirect", () => {
  const code = "1234567890abcdef1234567890abcdef";
  const expected = "/contractor-invite?code=" + code.toUpperCase();
  assert.equal(authDestination("/", "/contractor-invite?code=" + code), expected);
  assert.equal(safeReturnPath("/contractor-invite?code=bad-code"), "/contractor-invite");
  assert.equal(safeReturnPath("/contractor/job/00000000-0000-4000-8000-000000000001"), "/contractor/job/00000000-0000-4000-8000-000000000001");
  assert.equal(safeReturnPath("/contractor/job/elsewhere"), "/");
});

test("appointment proposals preserve local calendar times and reject invalid windows", () => {
  const day = "2030-02-01";
  const earlier = new Date(2030, 0, 31, 12).getTime();
  const valid = visitWindow(day + " 08:30", day + " 09:15", earlier);
  assert.equal(new Date(valid.p_start).getHours(), 8);
  assert.equal(new Date(valid.p_end).getMinutes(), 15);
  assert.equal(Date.parse(valid.p_end) - Date.parse(valid.p_start), 45 * 60_000);
  for (const start of ["2030-02-30 08:00", "2030-02-28 24:00", "2030-2-1 07:30", "2030-02-01T08:99"]) {
    assert.throws(() => visitWindow(start, day + " 18:00", earlier));
  }
  assert.throws(() => visitWindow(day + " 08:30", day + " 08:30", earlier), /after/);
  assert.throws(() => visitWindow(day + " 07:30", day + " 08:30", Date.parse(valid.p_end)), /future/);
});
