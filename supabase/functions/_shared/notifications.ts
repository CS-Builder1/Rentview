export type Delivery = {
  status: "accepted" | "delivered" | "failed" | "skipped";
  channel: "push" | "email";
  userId: string;
  ticketId?: string;
  error?: string;
  attemptedAt: string;
};
export type Deliveries = Record<string, Delivery>;

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
export function clamp(value: string, max = 140): string {
  const normalized = value.trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}
export function chunked<T>(items: T[], size = 100): T[][] {
  if (!Number.isSafeInteger(size) || size < 1 || size > 1000) throw new RangeError("Invalid chunk size");
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
export function accepted(delivery: Delivery | undefined): boolean { return delivery?.status === "accepted" || delivery?.status === "delivered"; }
export function safeDeliveryMap(value: unknown): Deliveries {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry && typeof entry === "object" && ["accepted", "delivered", "failed", "skipped"].includes(entry.status) && ["push", "email"].includes(entry.channel) && typeof entry.userId === "string"));
}
export function notificationEmail(title: string, body: string): { html: string; text: string } {
  return {
    html: `<!doctype html><html lang="en"><head><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p>Open RentView to view the full update and reply.</p></body></html>`,
    text: `${title}\n\n${body}\n\nOpen RentView to view the full update and reply.`,
  };
}
export function reminderCalendar(now: Date, timeZone: string): { today: string; soon: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 30);
  return { today, soon: date.toISOString().slice(0, 10), hour: Number(part("hour")) };
}
