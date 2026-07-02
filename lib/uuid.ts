/**
 * UUID v4 generator that works everywhere the app runs (web + Hermes).
 * Used for client-generated ids so offline-queued rows and their photo
 * storage paths can reference each other before the insert syncs.
 * Prefers the platform's crypto when available.
 */
export function newUuid(): string {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  let bytes: Uint8Array;
  if (g.crypto?.getRandomValues) {
    bytes = g.crypto.getRandomValues(new Uint8Array(16));
  } else {
    bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
