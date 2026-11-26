import { decimalCell, toCsv, type Cell } from "./csvCore";
import { totalsByCurrency } from "./dashboard";

export type StatementEntry = {
  date: string; property: string; unit: string; label: string; vendor: string;
  type: "Rent received" | "Expense incurred"; amount: number; currency: string;
};

export function operatingStatement(entries: StatementEntry[]): string {
  const rows: Cell[][] = [...entries].sort((a, b) => a.date.localeCompare(b.date)).map(e =>
    [e.date, e.property, e.unit, e.type, e.label, e.vendor, decimalCell(e.amount), e.currency]);
  const income = totalsByCurrency(entries.filter(e => e.type === "Rent received"));
  const expenses = totalsByCurrency(entries.filter(e => e.type === "Expense incurred"));
  const difference = totalsByCurrency(entries.map(e => ({ currency: e.currency, amount: e.type === "Rent received" ? e.amount : -e.amount })));
  rows.push([]);
  for (const currency of Object.keys(difference).sort()) {
    for (const [label,total] of [["Total rent received",income[currency] ?? 0],["Total expenses incurred",expenses[currency] ?? 0],["Rent less expenses",difference[currency]]] as const) {
      rows.push(["","","", label,"","",decimalCell(total),currency]);
    }
  }
  return toCsv(["Date","Property","Unit","Entry","Description","Vendor","Amount","Currency"], rows);
}
