export type CurrencyAmount = { currency: string; amount: number };
export function totalsByCurrency(rows: CurrencyAmount[]): Record<string, number> {
  const totals: Record<string, number> = Object.create(null);
  for (const row of rows) {
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || !/^[A-Z]{3}$/.test(row.currency)) throw new Error("Some financial records need correction before a total can be shown.");
    const cents = (totals[row.currency] ?? 0) + Math.round(amount * 100);
    if (!Number.isSafeInteger(cents)) throw new Error("The total exceeds the supported precision.");
    totals[row.currency] = cents;
  }
  return Object.fromEntries(Object.entries(totals).map(([currency, cents]) => {
    const amount = cents / 100;
    // Safe integer cents can still lose a cent when converted back to a
    // floating-point amount. Check both CSV fixed decimals and the canonical
    // decimal used by Intl display; a multiply/round trip alone can also round
    // incorrectly near the safe-integer boundary.
    const [whole, fraction = ""] = amount.toString().split(".");
    if (fraction.length > 2 || Number(`${whole}${fraction.padEnd(2, "0")}`) !== cents ||
        Number(amount.toFixed(2).replace(".", "")) !== cents) {
      throw new Error("The total exceeds the supported precision.");
    }
    return [currency, amount];
  }));
}
export function requiredCount(result: { count: number | null; error: unknown }): number {
  if (result.error) throw result.error;
  if (result.count === null || !Number.isSafeInteger(result.count) || result.count < 0) throw new Error("The portfolio summary could not be loaded.");
  return result.count;
}
