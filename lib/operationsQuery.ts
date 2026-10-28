/** Complete ordered reads fail as a whole; partial pages must never look like the full portfolio. */
export async function readAllPages<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown; count?: number | null }>, pageSize = 250, maxRows = 50000): Promise<{ data: T[] | null; error: unknown }> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || !Number.isSafeInteger(maxRows) || maxRows < pageSize) throw new Error("Invalid page limits.");
  const rows: T[] = [];
  let expectedTotal: number | null = null;
  try {
    while (rows.length < maxRows) {
      const result = await fetchPage(rows.length, rows.length + pageSize - 1);
      if (result.error) return { data: null, error: result.error };
      if (result.count != null) {
        if (!Number.isSafeInteger(result.count) || result.count < 0 || (expectedTotal !== null && expectedTotal !== result.count)) return { data: null, error: new Error("The list changed while loading. Refresh to load a complete result.") };
        expectedTotal = result.count;
        if (expectedTotal > maxRows) return { data: null, error: new Error("There are too many records to load at once. Please use a narrower view.") };
      }
      const page = result.data ?? [];
      if (page.length > pageSize) return { data: null, error: new Error("The result was not paginated as requested.") };
      rows.push(...page);
      if (expectedTotal !== null) {
        if (rows.length > expectedTotal || (!page.length && rows.length < expectedTotal)) return { data: null, error: new Error("The complete list could not be loaded. Refresh before continuing.") };
        if (rows.length === expectedTotal) return { data: rows, error: null };
      } else if (page.length < pageSize) return { data: rows, error: null };
    }
    return { data: null, error: new Error("There are too many records to load at once. Please use a narrower view.") };
  } catch (error) { return { data: null, error }; }
}

export function operationError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string" && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "The action could not be completed. Please retry.";
}
