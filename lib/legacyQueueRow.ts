/** AsyncStorage 2.x on Android uses RKStorage.catalystLocalStorage(key, value).
 * Read the oversized TEXT in bounded pieces within a caller-owned read transaction.
 * SQLite counts Unicode code points for substr; its offset must not use JS string length.
 */
export async function readLegacyQueueRow(
  key: string,
  get: (sql: string, offset: number, count: number, key: string) => Promise<{ chunk: string } | null>,
): Promise<string> {
  const chunks: string[] = [];
  const size = 128 * 1024;
  for (let offset = 1; ; offset += size) {
    const row = await get("SELECT substr(value, ?, ?) AS chunk FROM catalystLocalStorage WHERE key = ?", offset, size, key);
    if (!row) throw new Error("The original offline queue could not be recovered from device storage.");
    if (row.chunk === "") return chunks.join("");
    chunks.push(row.chunk);
  }
}
