import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareRooms,
  filterHistory,
  historyEvidenceBucket,
  inspectionError,
  type HistoryEvent,
  type Room,
} from "../lib/history";

const room = (room: string, condition: string): Room => ({
  room,
  condition,
  notes: "",
  evidence: [],
});

test("inspection comparison includes changed, added and missing rooms", () => {
  const comparison = compareRooms(
    [room("Kitchen", "good"), room("Bedroom", "worn")],
    [room(" kitchen ", "damaged"), room("Hall", "good")],
  );
  assert.deepEqual(
    comparison.map((r) => [r.room, r.before?.condition, r.after?.condition]),
    [
      ["Bedroom", "worn", undefined],
      ["Hall", undefined, "good"],
      ["Kitchen", "good", "damaged"],
    ],
  );
});
test("a search for a finding returns its dated inspection and original room evidence", () => {
  const entry: HistoryEvent = {
    id: "inspection:1",
    property_id: "building",
    unit_id: "2a",
    asset_id: null,
    lease_id: "lease",
    job_id: null,
    request_id: null,
    manual_id: "1",
    event_date: "2026-04-01",
    event_time: null,
    kind: "inspection",
    title: "Move-in",
    scope_label: "2A",
    unresolved: true,
    details: null,
    rooms: [
      {
        ...room("Bedroom", "worn"),
        notes: "Hinge loose",
        evidence: ["history/photo"],
      },
    ],
    evidence: [],
    amount: null,
    currency: null,
    observer: "Manager",
    recorded_by: "Manager",
    phase: "move_in",
  };
  const events = [
    entry,
    {
      ...entry,
      id: "2",
      event_date: "2026-04-03",
      kind: "observation",
      unresolved: false,
    },
  ];
  assert.deepEqual(
    filterHistory(events, {
      kind: "inspection",
      from: "2026-04-01",
      to: "2026-04-01",
      search: "hinge",
      openOnly: true,
    }),
    [entry],
  );
});
test("room observations require distinct room labels and supported conditions", () => {
  assert.match(inspectionError([]) ?? "", /room/i);
  assert.match(
    inspectionError([room("Kitchen", "good"), room(" kitchen ", "worn")]) ?? "",
    /once/i,
  );
  assert.match(
    inspectionError([room("Kitchen", "invented")]) ?? "",
    /condition/i,
  );
  assert.equal(inspectionError([room("Kitchen", "good")]), null);
});

test("dispatch photos and inspection evidence resolve in their own private storage buckets", () => {
  assert.equal(historyEvidenceBucket("dispatch"), "dispatch-photos");
  assert.equal(historyEvidenceBucket("inspection"), "attachments");
  assert.equal(historyEvidenceBucket("request_photo"), "attachments");
});
