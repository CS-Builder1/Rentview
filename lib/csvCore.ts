type DecimalCell = { readonly decimal: number };
export type Cell = string | number | DecimalCell | null | undefined;
/** Explicit numeric cells retain fixed cents without treating exported text as a formula. */
export function decimalCell(value: number): DecimalCell {
  const text = value.toFixed(2);
  if (!Number.isFinite(value) || /e/i.test(text) || Number(text) !== value) {
    throw new Error("CSV amount exceeds supported decimal precision.");
  }
  return { decimal: value };
}
/** Treat exported text as data: spreadsheet formula syntax must never execute. */
export function escapeCell(value: Cell): string {
  if (value != null && typeof value === "object") return decimalCell(value.decimal).decimal.toFixed(2);
  let text = value == null ? "" : String(value);
  if (typeof value === "string" && (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export function toCsv(headers: string[], rows: Cell[][]): string {
  return [headers, ...rows].map(row => row.map(escapeCell).join(",")).join("\r\n");
}
