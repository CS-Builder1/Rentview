import { localToday } from "./maintenance";
import { totalsByCurrency } from "./dashboard";

export const localDateKey = localToday;
export type RentRecord = {
  lease_id: string;
  amount: number;
  currency: string;
  due_date: string | null;
  paid_on: string | null;
  applied_amount?: number;
};
export type RentState = "paid" | "overdue" | "due" | "upcoming" | "unscheduled";

export function rentRemaining(record: Pick<RentRecord, "amount" | "applied_amount">): number {
  return (Math.round(record.amount * 100) - Math.round((record.applied_amount ?? 0) * 100)) / 100;
}

export function rentState(
  record: Pick<RentRecord, "paid_on" | "due_date"> & Partial<Pick<RentRecord, "amount" | "applied_amount">>,
  today = localToday(),
): RentState {
  if (record.paid_on || (record.amount != null && rentRemaining({ amount: record.amount, applied_amount: record.applied_amount }) === 0)) return "paid";
  if (!record.due_date) return "unscheduled";
  if (record.due_date < today) return "overdue";
  return record.due_date === today ? "due" : "upcoming";
}

type UnpaidState = Exclude<RentState, "paid">;
type Summary = { leaseId: string; currency: string } & Record<UnpaidState, number>;

export function rentSummaries(records: RentRecord[], today = localToday()): Summary[] {
  const groups = new Map<string, { summary: Summary; rows: Record<UnpaidState, { currency: string; amount: number }[]> }>();
  for (const record of records) {
    const state = rentState(record, today);
    if (state === "paid") continue;
    const key = record.lease_id + ":" + record.currency;
    if (!groups.has(key)) groups.set(key, {
      summary: { leaseId: record.lease_id, currency: record.currency, overdue: 0, due: 0, upcoming: 0, unscheduled: 0 },
      rows: { overdue: [], due: [], upcoming: [], unscheduled: [] },
    });
    groups.get(key)!.rows[state].push({ currency: record.currency, amount: rentRemaining(record) });
  }
  return [...groups.values()].map(({ summary, rows }) => {
    for (const state of Object.keys(rows) as UnpaidState[]) {
      summary[state] = totalsByCurrency(rows[state])[summary.currency] ?? 0;
    }
    return summary;
  });
}

export function rentSummaryResult(records: RentRecord[]): { groups: Summary[]; error: string | null } {
  try { return { groups: rentSummaries(records), error: null }; }
  catch (error) {
    return { groups: [], error: error instanceof Error ? error.message : "The rent balance could not be calculated." };
  }
}
