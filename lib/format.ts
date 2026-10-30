// Internationally-neutral formatting helpers.
// Currency and dates follow the data's own currency code / the device locale.

export function formatCurrency(
  amount: number | null | undefined,
  currency = "USD",
): string {
  if (amount === null || amount === undefined) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    // Fallback if the currency code is unknown to Intl.
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  // A calendar date has no timezone; format it as UTC to preserve its day.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(dateOnly ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return "—";
  if (dateOnly && d.toISOString().slice(0, 10) !== value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", ...(dateOnly ? { timeZone: "UTC" } : {}) }).format(d);
}

export function titleCase(value: string): string {
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
