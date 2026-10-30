/** Durable, account-scoped offline state. This module has no React/native dependencies. */
import { MAX_IMAGE_BYTES } from "./uploadPolicy";
export interface QueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const OFFLINE_TABLES = ["assets", "expenses", "leases", "work_orders"] as const;
export type OfflineTable = (typeof OFFLINE_TABLES)[number];
const PREFIX = "rentview.offline.queue.v2.";
const LEGACY_KEY = "rentview.offline.queue.v1";
const QUARANTINE_KEY = "rentview.offline.quarantine.v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type OperationState = {
  id: string;
  accountId: string;
  createdAt: number;
  revision: number;
  status: "pending" | "failed";
  attempts: number;
  error: string | null;
  lastAttemptAt: number | null;
  legacySource?: string;
};
export type QueuedInsert = OperationState & {
  kind: "insert";
  table: OfflineTable;
  payload: Record<string, unknown>;
};
export type QueuedPhoto = OperationState & {
  kind: "photo";
  base64: string;
  contentType: string;
  storagePath: string;
  doc: Record<string, unknown>;
};
export type QueuedOp = QueuedInsert | QueuedPhoto;
export type PhotoSubmission = Pick<QueuedPhoto, "base64" | "contentType" | "storagePath" | "doc">;

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String(error.message)
      : String(error ?? "Unknown error");
}

export function isNetworkError(error: unknown): boolean {
  return /network request failed|failed to fetch|load failed|fetch failed|networkerror|timeout|network connection|internet connection/i.test(errorMessage(error));
}

function assertAccount(accountId: string): void {
  if (!UUID.test(accountId)) throw new Error("Sign in before saving an offline change.");
}

function assertJson(value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Enter a valid number before saving.");
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) assertJson(child);
  }
}

function assertInsert(accountId: string, table: string, payload: Record<string, unknown>): asserts table is OfflineTable {
  assertAccount(accountId);
  if (!(OFFLINE_TABLES as readonly string[]).includes(table)) throw new Error("This action requires a connection.");
  if (payload.owner_id !== accountId) throw new Error("The offline change belongs to a different account.");
  if (!UUID.test(String(payload.id ?? ""))) throw new Error("The offline change has no valid record ID.");
  assertJson(payload);
}

function assertPhoto(accountId: string, photo: PhotoSubmission): void {
  assertAccount(accountId);
  if (photo.doc.owner_id !== accountId || photo.storagePath.split("/")[0] !== accountId) {
    throw new Error("The photo belongs to a different account.");
  }
  if (!UUID.test(String(photo.doc.id ?? ""))) throw new Error("The photo has no valid record ID.");
  if (photo.storagePath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("The photo path is invalid.");
  if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(photo.contentType)) throw new Error("Choose a supported photo format.");
  const decodedBytes = photo.base64.length / 4 * 3 - (photo.base64.endsWith("==") ? 2 : photo.base64.endsWith("=") ? 1 : 0);
  if (!photo.base64 || photo.base64.length % 4 !== 0 || decodedBytes > MAX_IMAGE_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(photo.base64)) {
    throw new Error("Choose a photo smaller than 10 MB.");
  }
  assertJson(photo.doc);
}

function decodeQueue(raw: string | null, accountId: string): QueuedOp[] {
  if (raw === null) return [];
  try {
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items)) throw new Error();
    for (const entry of items) {
      if (!entry || typeof entry !== "object") throw new Error();
      const op = entry as QueuedOp;
      if (op.accountId !== accountId || !UUID.test(op.id) || !Number.isInteger(op.revision) || op.revision < 0 ||
          !Number.isFinite(op.createdAt) || !Number.isInteger(op.attempts) || op.attempts < 0 ||
          !["pending", "failed"].includes(op.status)) throw new Error();
      if (op.kind === "insert") { assertInsert(accountId, op.table, op.payload); if (op.payload.id !== op.id) throw new Error(); }
      else if (op.kind === "photo") { assertPhoto(accountId, op); if (op.doc.id !== op.id) throw new Error(); }
      else throw new Error();
    }
    return items as QueuedOp[];
  } catch {
    // Preserve the original bytes. An unreadable queue is never an empty queue.
    throw new Error("Saved changes could not be read. They have been preserved on this device; contact support before clearing app storage.");
  }
}

export function createOfflineStore(storage: QueueStorage, randomUUID: () => string, now = Date.now, exclusive?: <T>(work: () => Promise<T>) => Promise<T>) {
  let serial: Promise<unknown> = Promise.resolve();
  const lock = <T>(work: () => Promise<T>): Promise<T> => {
    const execute = () => exclusive ? exclusive(work) : work();
    const result = serial.then(execute, execute);
    serial = result.catch(() => undefined);
    return result;
  };
  const key = (accountId: string) => PREFIX + accountId;
  const readUnlocked = async (accountId: string) => decodeQueue(await storage.getItem(key(accountId)), accountId);
  const write = async (accountId: string, items: QueuedOp[]) => storage.setItem(key(accountId), JSON.stringify(items));
  const base = (accountId: string, id: string): OperationState => ({
    id, accountId, createdAt: now(), revision: 0, status: "pending", attempts: 0, error: null, lastAttemptAt: null,
  });

  function prepareInsert(accountId: string, table: string, payload: Record<string, unknown>): QueuedInsert {
    const id = payload.id === undefined ? randomUUID() : String(payload.id);
    const next = { ...payload, id };
    assertInsert(accountId, table, next);
    return { ...base(accountId, id), kind: "insert", table, payload: next };
  }

  function preparePhoto(accountId: string, photo: PhotoSubmission): QueuedPhoto {
    const id = photo.doc.id === undefined ? randomUUID() : String(photo.doc.id);
    const slash = photo.storagePath.lastIndexOf("/");
    const filename = photo.storagePath.slice(slash + 1);
    const dot = filename.lastIndexOf(".");
    const uniqueName = dot < 0 ? `${filename}-${id}` : `${filename.slice(0, dot)}-${id}${filename.slice(dot)}`;
    const next = { ...photo, storagePath: `${photo.storagePath.slice(0, slash + 1)}${uniqueName}`, doc: { ...photo.doc, id } };
    assertPhoto(accountId, next);
    return { ...base(accountId, id), kind: "photo", ...next };
  }

  async function migrateLegacy(): Promise<void> {
    const raw = await storage.getItem(LEGACY_KEY);
    if (raw === null) return;
    let legacy: unknown;
    try { legacy = JSON.parse(raw); } catch { throw new Error("Older offline changes could not be read. They are preserved; contact support before clearing app storage."); }
    if (!Array.isArray(legacy)) throw new Error("Older offline changes are preserved but need support to recover.");
    const groups = new Map<string, QueuedOp[]>();
    const invalid: unknown[] = [];
    for (let index = 0; index < legacy.length; index += 1) {
      const entry = legacy[index];
      try {
        if (!entry || typeof entry !== "object") throw new Error();
        const old = entry as Record<string, unknown>;
        const photo = old.kind === "photo";
        const payload = (photo ? old.doc : old.payload) as Record<string, unknown>;
        const accountId = String(payload?.owner_id ?? "");
        assertAccount(accountId);
        const items = groups.get(accountId) ?? await readUnlocked(accountId);
        groups.set(accountId, items);
        const legacySource = `${index}:${String(old.id ?? "unknown")}`;
        if (items.some((op) => op.legacySource === legacySource)) continue;
        const op = photo
          ? preparePhoto(accountId, old as unknown as PhotoSubmission)
          : prepareInsert(accountId, String(old.table), payload);
        op.legacySource = legacySource;
        op.status = "failed";
        op.error = "Recovered from an older app version. Check for an existing record before retrying; older changes had no duplicate protection.";
        items.push(op);
      } catch { invalid.push(entry); }
    }
    for (const [accountId, items] of groups) await write(accountId, items);
    if (invalid.length) {
      // Unknown owners are not displayed to a possibly unrelated signed-in user.
      const previousRaw = await storage.getItem(QUARANTINE_KEY);
      let previous: unknown[] = [];
      if (previousRaw !== null) {
        try {
          const parsed: unknown = JSON.parse(previousRaw);
          previous = Array.isArray(parsed) ? parsed : [{ preservedRaw: previousRaw }];
        } catch { previous = [{ preservedRaw: previousRaw }]; }
      }
      const known = new Set(previous.map((entry) => JSON.stringify(entry)));
      await storage.setItem(QUARANTINE_KEY, JSON.stringify([...previous, ...invalid.filter((entry) => !known.has(JSON.stringify(entry)))]));
    }
    // Remove only after every recovered entry or original invalid entry is persisted.
    await storage.removeItem(LEGACY_KEY);
  }

  const read = (accountId: string) => lock(async () => {
    assertAccount(accountId);
    await migrateLegacy();
    return readUnlocked(accountId);
  });

  const put = (op: QueuedOp) => lock(async () => {
    await migrateLegacy();
    decodeQueue(JSON.stringify([op]), op.accountId);
    const existing = await readUnlocked(op.accountId);
    if (existing.some((item) => item.id === op.id)) throw new Error("A change with this ID is already waiting to sync.");
    if (op.kind === "insert") assertInsert(op.accountId, op.table, op.payload); else assertPhoto(op.accountId, op);
    await write(op.accountId, [...existing, op]);
  });

  const modify = (accountId: string, id: string, transform: (item: QueuedOp) => QueuedOp | null, revision?: number) => lock(async () => {
    assertAccount(accountId);
    const items = await readUnlocked(accountId);
    const index = items.findIndex((item) => item.id === id && (revision === undefined || item.revision === revision));
    if (index < 0) return null;
    const next = transform(items[index]);
    if (next) items[index] = next; else items.splice(index, 1);
    await write(accountId, items);
    return next;
  });

  return {
    prepareInsert, preparePhoto, read, put,
    async hasQuarantinedChanges(): Promise<boolean> { return (await storage.getItem(QUARANTINE_KEY)) !== null; },
    remove: (accountId: string, id: string, revision?: number) => modify(accountId, id, () => null, revision),
    markAttempt: (accountId: string, id: string, revision: number) => modify(accountId, id,
      (item) => item.status !== "pending" ? item : { ...item, attempts: item.attempts + 1, lastAttemptAt: now() }, revision),
    fail: (accountId: string, id: string, error: unknown, revision: number, network = false) => modify(accountId, id,
      (item) => ({ ...item, status: network ? "pending" : "failed", error: errorMessage(error) }), revision),
    retry: (accountId: string, id: string) => modify(accountId, id,
      (item) => ({ ...item, status: "pending", error: null, revision: item.revision + 1 })),
    edit: (accountId: string, id: string, payload: Record<string, unknown>) => modify(accountId, id, (item) => {
      if (item.kind !== "insert") throw new Error("Discard this photo and choose it again to change it.");
      if (payload.id !== item.payload.id || payload.owner_id !== item.accountId) throw new Error("The record ID and account cannot be changed.");
      assertInsert(accountId, item.table, payload);
      return { ...item, payload, status: "pending", error: null, revision: item.revision + 1 };
    }),
  };
}

export type OfflineStore = ReturnType<typeof createOfflineStore>;

export interface OfflineTransport {
  insert(table: string, payload: Record<string, unknown>): Promise<{ error: unknown }>;
  find(table: string, id: string): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
  upload(photo: QueuedPhoto): Promise<void>;
  documentPayload(photo: QueuedPhoto): Record<string, unknown>;
}

function equalValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equalValue(value, b[index]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => equalValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

/** Only the exact intended record confirms a lost-acknowledgment retry. Never overwrite conflicts. */
export async function insertIdempotently(transport: OfflineTransport, table: string, payload: Record<string, unknown>): Promise<void> {
  const { error } = await transport.insert(table, payload);
  if (!error) return;
  if (typeof error !== "object" || !("code" in error) || error.code !== "23505") throw error;
  const { data, error: readError } = await transport.find(table, String(payload.id));
  if (readError) throw readError;
  if (!data || !Object.entries(payload).every(([key, value]) => equalValue(value, data[key]))) {
    throw new Error("A conflicting record already exists. Review the saved record before retrying or discarding this change.");
  }
}

export async function replayOperation(op: QueuedOp, transport: OfflineTransport): Promise<void> {
  if (op.kind === "insert") return insertIdempotently(transport, op.table, op.payload);
  await transport.upload(op);
  await insertIdempotently(transport, "documents", transport.documentPayload(op));
}

export async function flushOfflineQueue(store: OfflineStore, transport: OfflineTransport, accountId: string, maySync: () => boolean): Promise<number> {
  if (!maySync()) return 0;
  let synced = 0;
  const snapshot = await store.read(accountId);
  for (const pending of snapshot) {
    if (!maySync()) break;
    if (pending.status !== "pending") continue;
    const op = await store.markAttempt(accountId, pending.id, pending.revision);
    if (!op || op.status !== "pending" || !maySync()) continue;
    try {
      await replayOperation(op, transport);
      if (!maySync()) break; // Retain for a safe idempotent retry in the original account.
      await store.remove(accountId, op.id, op.revision);
      synced += 1;
    } catch (error) {
      const network = isNetworkError(error);
      await store.fail(accountId, op.id, error, op.revision, network);
      if (network || !maySync()) break;
    }
  }
  return synced;
}
