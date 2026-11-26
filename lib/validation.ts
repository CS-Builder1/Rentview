import { validCalendarDate } from "./maintenance";

export function currencyCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error("Enter a three-letter currency code, such as USD or XCD.");
  try { new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(0); }
  catch { throw new Error("Enter a valid currency code."); }
  return code;
}

export function calendarDate(value: string, label = "Date", optional = false): string | null {
  const date = value.trim();
  if (!date && optional) return null;
  if (!validCalendarDate(date)) throw new Error(`${label} must be a valid date in YYYY-MM-DD format.`);
  return date;
}

export function nonNegativeMoney(value: string, label: string): number {
  const raw = value.trim();
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(raw)) throw new Error(`${label} must be a valid amount with at most two decimal places.`);
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || amount > 9999999999) throw new Error(`${label} is outside the supported range.`);
  return amount;
}
