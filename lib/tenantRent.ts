import type { Database, Tables } from "./database.types";
import { newRecordId } from "./id";
import { localTimeZone, localToday } from "./maintenance";
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

export function availableReceiptAmount(record: Pick<RentRecord, "amount" | "applied_amount" | "due_date" | "paid_on">): number {
  // A legacy row with both dates is the receipt for its own charge.
  return record.paid_on && !record.due_date ? rentRemaining(record) : 0;
}

export type MarkPaidRequest = Database["public"]["Functions"]["apply_rent_receipt"]["Args"];

/** Keep the complete original request across a lost response, even if midnight
 * passes or a refresh already shows the receipt in the charge balance. */
export async function applyMarkPaid(
  pending: Map<string, MarkPaidRequest>,
  charge: Pick<Tables<"rent_record_balances">, "id" | "amount" | "applied_amount" | "method">,
  send: (request: MarkPaidRequest) => PromiseLike<{ error: unknown }>,
): Promise<void> {
  let request = pending.get(charge.id);
  if (!request) {
    request = {
      p_operation_id: newRecordId(),
      p_charge_id: charge.id,
      p_receipt_id: newRecordId(),
      p_amount: rentRemaining(charge),
      p_paid_on: localToday(),
      p_method: charge.method ?? null,
      p_time_zone: localTimeZone(),
    };
    pending.set(charge.id, request);
  }
  const result = await send(request);
  if (result.error) throw result.error;
  pending.delete(charge.id);
}
