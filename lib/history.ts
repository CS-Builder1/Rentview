export const conditions = [
  "good",
  "worn",
  "damaged",
  "missing",
  "not_inspected",
] as const;
export const entryKinds = [
  "observation",
  "inspection",
  "water_shutoff",
  "key_handover",
  "other",
] as const;
export type Room = {
  room: string;
  condition: string;
  notes: string;
  evidence: string[];
};
export type HistoryEvent = {
  id: string;
  event_date: string;
  event_time: string | null;
  kind: string;
  title: string;
  details: string | null;
  property_id: string;
  unit_id: string | null;
  asset_id: string | null;
  lease_id: string | null;
  scope_label: string;
  observer: string | null;
  recorded_by: string | null;
  phase: string | null;
  rooms: Room[];
  evidence: string[];
  unresolved: boolean;
  job_id: string | null;
  request_id: string | null;
  manual_id: string | null;
  amount: number | null;
  currency: string | null;
};
export type HistoryFilters = {
  kind: string;
  from: string;
  to: string;
  search: string;
  openOnly: boolean;
};
const roomKey = (name: string) => name.trim().toLowerCase();

export function inspectionError(rooms: Room[]): string | null {
  if (!rooms.length || rooms.length > 100)
    return "Record between one and 100 rooms or areas.";
  const seen = new Set<string>();
  for (const item of rooms) {
    const name = roomKey(item.room);
    if (!name) return "Name every room or area.";
    if (seen.has(name)) return "List each room or area only once.";
    seen.add(name);
    if (!conditions.some((c) => c === item.condition))
      return "Choose a condition for every room.";
  }
  return null;
}

export function compareRooms(before: Room[], after: Room[]) {
  const earlier = new Map(before.map((item) => [roomKey(item.room), item]));
  const later = new Map(after.map((item) => [roomKey(item.room), item]));
  return [...new Set([...earlier.keys(), ...later.keys()])]
    .sort()
    .map((key) => ({
      room: (earlier.get(key) ?? later.get(key))!.room.trim(),
      before: earlier.get(key),
      after: later.get(key),
    }));
}

export function filterHistory(
  events: HistoryEvent[],
  filters: HistoryFilters,
): HistoryEvent[] {
  const needle = filters.search.trim().toLowerCase();
  return events.filter((e) => {
    if (filters.kind && e.kind !== filters.kind) return false;
    if (
      (filters.from && e.event_date < filters.from) ||
      (filters.to && e.event_date > filters.to)
    )
      return false;
    if (filters.openOnly && !e.unresolved) return false;
    const searchable = [
      e.title,
      e.details,
      e.scope_label,
      e.observer,
      e.recorded_by,
      e.phase,
      ...e.rooms.flatMap((r) => [r.room, r.condition, r.notes]),
    ];
    return !needle || searchable.join(" ").toLowerCase().includes(needle);
  });
}

/** The field crew uploads completion photos to a separate participant-scoped bucket. */
export function historyEvidenceBucket(
  kind: string,
): "attachments" | "dispatch-photos" {
  return kind === "dispatch" ? "dispatch-photos" : "attachments";
}

export function draftPhotos(rooms: Room[], evidence: string[]): string[] {
  return [...new Set([...evidence, ...rooms.flatMap((room) => room.evidence)])];
}

export function historyEvidencePayload(inspection: boolean, rooms: Room[], evidence: string[]) {
  if (inspection) return { p_rooms: rooms, p_evidence: evidence };

  // Keep previously uploaded room photos when the draft changes event type.
  const paths = draftPhotos(rooms, evidence);
  if (paths.length > 10) {
    throw new Error("An entry can hold 10 photos. Save this draft as an inspection to retain all room photos.");
  }
  return { p_rooms: [], p_evidence: paths };
}
