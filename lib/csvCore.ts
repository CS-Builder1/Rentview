export type Cell = string | number | null | undefined;
/** Treat exported text as data: spreadsheet formula syntax must never execute. */
export function escapeCell(value: Cell): string {
  let text = value == null ? "" : String(value);
  if (typeof value === "string" && (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export function toCsv(headers: string[], rows: Cell[][]): string {
  return [headers, ...rows].map(row => row.map(escapeCell).join(",")).join("\r\n");
}
