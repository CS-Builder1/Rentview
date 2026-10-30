/** One user intent keeps its record identity through failed or ambiguous saves. */
export type InsertDraft = { id: string; accountId: string };

export function createInsertDraft(accountId: string, randomUUID: () => string): InsertDraft {
  return { id: randomUUID(), accountId };
}

export function insertDraftIdentity(
  draft: InsertDraft | null,
  accountId: string,
  operations: readonly { id: string }[],
  label: string,
): { id: string; owner_id: string } {
  if (!draft || draft.accountId !== accountId) {
    throw new Error(`Reopen this ${label}. This draft belongs to a different signed-in account or is no longer active.`);
  }
  if (operations.some((operation) => operation.id === draft.id)) {
    throw new Error(`This ${label} is already saved on this device. Open Saved changes to edit, retry or discard it before creating another ${label}.`);
  }
  return { id: draft.id, owner_id: draft.accountId };
}
