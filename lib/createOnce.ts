/** Confirm a create after an ambiguous response without overwriting another record.
 * The caller must retain the same client-generated ID for the lifetime of its draft.
 */
export type CreateResult<T> = { data: T | null; error: unknown };
function recoverable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown; status?: unknown };
  return value.code === "23505" || Number(value.status) >= 500 ||
    /network|fetch|connection|timeout|load failed/i.test(String(value.message ?? ""));
}
export async function createOnce<T extends { id: string }>(
  expected: T,
  insert: () => PromiseLike<CreateResult<{ id: string }>>,
  inspect: () => PromiseLike<CreateResult<T>>,
): Promise<{ id: string }> {
  let failure: unknown;
  try {
    const result = await insert();
    if (!result.error && result.data?.id === expected.id) return result.data;
    failure = result.error ?? new Error("The record was not confirmed as saved. Please retry.");
  } catch (error) { failure = error; }
  if (recoverable(failure)) {
    try {
      const result = await inspect();
      const existing = result.data;
      if (!result.error && existing && Object.entries(expected).every(([key, value]) =>
        Object.prototype.hasOwnProperty.call(existing, key) && existing[key as keyof T] === value)) {
        return { id: expected.id };
      }
      if (!result.error && result.data) throw new Error("A record from this draft already exists with different details. Review it before creating another record.");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("A record from this draft")) throw error;
      // Preserve the original actionable failure when verification is unavailable.
    }
  }
  throw failure;
}
