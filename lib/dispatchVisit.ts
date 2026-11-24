/** Parse an explicit wall-clock time using the device's local time zone.
 * Comparing every component rejects rolled-over dates and missing DST hours. */
function localInstant(value: string): Date {
  const parts = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value.trim());
  if (!parts) throw new Error("Enter each date and time as YYYY-MM-DD HH:MM.");
  const [year, month, day, hour, minute] = parts.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day ||
      date.getHours() !== hour || date.getMinutes() !== minute) {
    throw new Error("Enter a valid local date and time.");
  }
  return date;
}

export function visitWindow(start: string, end: string, now = Date.now()) {
  const from = localInstant(start), until = localInstant(end);
  if (from.getTime() <= now) throw new Error("Choose a future visit time.");
  if (until <= from) throw new Error("The visit must end after it starts.");
  return { p_start: from.toISOString(), p_end: until.toISOString() };
}

export function displayVisit(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(iso));
}
