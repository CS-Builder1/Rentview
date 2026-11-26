import { calendarDate, currencyCode, nonNegativeMoney } from "./validation";

export const savedChangeLabels: Record<string, string> = {
  assets: "Asset", expenses: "Expense", leases: "Lease", work_orders: "Work order",
  title: "Title", name: "Name", description: "Description", tenant_name: "Tenant name", tenant_email: "Tenant email",
  amount: "Amount", rent_amount: "Rent amount", purchase_cost: "Purchase cost", deposit_amount: "Deposit", currency: "Currency", rent_currency: "Rent currency",
  purchase_currency: "Purchase currency", due_date: "Due date", start_date: "Start date", end_date: "End date",
  incurred_on: "Expense date", install_date: "Installed date", warranty_expiry: "Warranty expiry",
};
export const savedChangeNumericFields = new Set(["amount", "rent_amount", "purchase_cost", "deposit_amount"]);
const dates = new Set(["due_date", "start_date", "end_date", "incurred_on", "install_date", "warranty_expiry"]);

export function editedSavedChange(
  table: string,
  original: Record<string, unknown>,
  values: Record<string, string>,
): Record<string, unknown> {
  const payload = { ...original };
  for (const [key, value] of Object.entries(values)) {
    const trimmed = value.trim();
    const label = savedChangeLabels[key] ?? key;
    if (savedChangeNumericFields.has(key)) {
      // Rent, purchase cost and deposits are nullable in their forms/schema.
      // Clearing them must not block editing unrelated saved details.
      payload[key] = !trimmed && key !== "amount" ? null : nonNegativeMoney(trimmed, label);
    } else if (dates.has(key)) {
      payload[key] = calendarDate(trimmed, label, !(table === "expenses" && key === "incurred_on"));
    } else if (key.endsWith("currency") || key === "currency") {
      payload[key] = !trimmed && key !== "currency" ? null : currencyCode(trimmed);
    } else payload[key] = trimmed || null;
  }
  if (typeof payload.start_date === "string" && typeof payload.end_date === "string" && payload.end_date < payload.start_date) {
    throw new Error("Lease end cannot be before the start date.");
  }
  return payload;
}
