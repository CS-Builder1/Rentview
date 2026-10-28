/** Calendar-only helpers: never parse a date-only value as a local timestamp. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
export function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function nextMaintenanceDate(anchor: string, frequency: string, intervalDays?: number | null): string {
  if (!validCalendarDate(anchor)) throw new Error("Choose a valid calendar date.");
  const date = new Date(`${anchor}T12:00:00Z`);
  const months = { monthly: 1, quarterly: 3, biannual: 6, annual: 12 }[frequency];
  if (months) {
    const day = date.getUTCDate();
    date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  } else {
    const days = frequency === "daily" ? 1 : frequency === "weekly" ? 7 : frequency === "custom" ? intervalDays : undefined;
    if (!days || !Number.isSafeInteger(days) || days < 1 || days > 36500) throw new Error("Enter a whole interval from 1 to 36,500 days.");
    date.setUTCDate(date.getUTCDate() + days);
  }
  return date.toISOString().slice(0, 10);
}
export function positiveNumber(value: string, label: string, allowZero = false): number {
  if (!value.trim() || !/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(value.trim())) throw new Error(`${label} must be a valid number with at most two decimal places.`);
  const n = Number(value);
  if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0) || n > 9999999999) throw new Error(`${label} must be ${allowZero ? "zero or greater" : "greater than zero"}.`);
  return n;
}
export function partTotalsByCurrency(parts: { quantity: number; unit_cost: number | null; cost_currency: string | null }[], fallback: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const part of parts) {
    const currency = part.cost_currency || fallback;
    totals.set(currency, (totals.get(currency) ?? 0) + Number(part.quantity) * Number(part.unit_cost ?? 0));
  }
  return totals;
}
