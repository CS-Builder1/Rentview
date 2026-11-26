/** Durable, account-scoped offline state. This module has no React/native dependencies. */
import { decode } from "base64-arraybuffer";
import type { PhotoStorage } from "./photoStorage";
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
  photoKey: string;
  byteLength: number;
  contentType: string;
  storagePath: string;
  doc: Record<string, unknown>;
};
export type QueuedOp = QueuedInsert | QueuedPhoto;
export type PhotoSubmission = Pick<QueuedPhoto, "contentType" | "storagePath" | "doc"> & { base64: string };
type InlinePhoto = Omit<QueuedPhoto, "photoKey" | "byteLength"> & { base64: string };
export type PreparedOperation = QueuedInsert | InlinePhoto;
type StoredOperation = QueuedOp | InlinePhoto;

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

function assertPhoto(accountId: string, photo: Pick<PhotoSubmission, "doc" | "storagePath" | "contentType">): void {
  assertAccount(accountId);
  if (photo.doc.owner_id !== accountId || photo.storagePath.split("/")[0] !== accountId) {
    throw new Error("The photo belongs to a different account.");
  }
  if (!UUID.test(String(photo.doc.id ?? ""))) throw new Error("The photo has no valid record ID.");
  if (photo.storagePath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("The photo path is invalid.");
  if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(photo.contentType)) throw new Error("Choose a supported photo format.");
  assertJson(photo.doc);
}

function sizeOfBase64(encoded: string): number {
  const bytes = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  if (!encoded || encoded.length % 4 !== 0 || bytes > MAX_IMAGE_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("Choose a valid photo no larger than 10 MB.");
  }
  return bytes;
}

function assertOperation(op: StoredOperation, accountId: string): void {
  if (op.accountId !== accountId || !UUID.test(op.id) || !Number.isInteger(op.revision) || op.revision < 0 ||
      !Number.isFinite(op.createdAt) || !Number.isInteger(op.attempts) || op.attempts < 0 ||
      !["pending", "failed"].includes(op.status)) throw new Error("Invalid saved operation.");
  if (op.kind === "insert") {
    assertInsert(accountId, op.table, op.payload);
    if (op.payload.id !== op.id) throw new Error("Invalid saved insert identity. Existing data was preserved.");
  } else if (op.kind === "photo") {
    assertPhoto(accountId, op);
    if (op.doc.id !== op.id) throw new Error("Invalid saved photo identity.");
    if ("base64" in op) sizeOfBase64(op.base64);
    else if (op.photoKey !== accountId + "/" + op.id || !Number.isSafeInteger(op.byteLength) ||
        op.byteLength <= 0 || op.byteLength > MAX_IMAGE_BYTES) throw new Error("Invalid saved photo reference.");
  } else throw new Error("Unsupported saved operation.");
}

function decodeQueue(raw: string | null, accountId: string): StoredOperation[] {
  if (raw === null) return [];
  try {
    const items: StoredOperation[] = JSON.parse(raw);
    if (!Array.isArray(items)) throw new Error();
    for (const item of items) assertOperation(item, accountId);
    return items;
  } catch {
    throw new Error("Saved changes could not be read. They have been preserved on this device; contact support before clearing app storage.");
  }
}

export function createOfflineStore(storage: QueueStorage, randomUUID: () => string, now = Date.now, exclusive?: <T>(work: () => Promise<T>) => Promise<T>, photos?: PhotoStorage) {
  let serial: Promise<unknown> = Promise.resolve();
  const lock = <T>(work: () => Promise<T>): Promise<T> => {
    const execute = () => exclusive ? exclusive(work) : work();
    const result = serial.then(execute, execute);
    serial = result.catch(() => undefined);
    return result;
  };
  const key = (accountId: string) => PREFIX + accountId;
  const write = (accountId: string, items: QueuedOp[]) => storage.setItem(key(accountId), JSON.stringify(items));
  const cleaned = new Set<string>();

  function photoStorage(): PhotoStorage {
    if (!photos) throw new Error("Photo storage is unavailable on this device.");
    return photos;
  }

  async function persistPhoto(op: InlinePhoto): Promise<QueuedPhoto> {
    const { base64, ...metadata } = op;
    const bytes = decode(base64);
    const photoKey = op.accountId + "/" + op.id;
    await photoStorage().write(photoKey, bytes);
    return { ...metadata, photoKey, byteLength: bytes.byteLength };
  }

  async function readUnlocked(accountId: string): Promise<QueuedOp[]> {
    const original = decodeQueue(await storage.getItem(key(accountId)), accountId);
    const items: QueuedOp[] = [];
    let migrated = false;
    for (const op of original) {
      if (op.kind === "photo" && "base64" in op) {
        items.push(await persistPhoto(op));
        migrated = true;
      } else items.push(op);
    }
    // Keep the original inline copy until all files and replacement metadata are durable.
    if (migrated) await write(accountId, items);
    // A crash between independent storage commits can leave an unreferenced file.
    // The same queue lock also protects this sweep across tabs and concurrent captures.
    if (photos && !cleaned.has(accountId)) {
      const keep = new Set(items.flatMap(op => op.kind === "photo" ? [op.photoKey] : []));
      try {
        for (const file of await photos.list(accountId)) if (!keep.has(file)) await photos.remove(file);
        cleaned.add(accountId);
      } catch { /* Retry cleanup on the next read. Other changes remain available. */ }
    }
    return items;
  }

  const base = (accountId: string, id: string): OperationState => ({
    id, accountId, createdAt: now(), revision: 0, status: "pending", attempts: 0, error: null, lastAttemptAt: null,
  });

  function prepareInsert(accountId: string, table: string, payload: Record<string, unknown>): QueuedInsert {
    const id = payload.id === undefined ? randomUUID() : String(payload.id);
    const next = { ...payload, id };
    assertInsert(accountId, table, next);
    return { ...base(accountId, id), kind: "insert", table, payload: next };
  }

  function preparePhoto(accountId: string, photo: PhotoSubmission): InlinePhoto {
    const id = photo.doc.id === undefined ? randomUUID() : String(photo.doc.id);
    const slash = photo.storagePath.lastIndexOf("/");
    const filename = photo.storagePath.slice(slash + 1);
    const dot = filename.lastIndexOf(".");
    const uniqueName = dot < 0 ? `${filename}-${id}` : `${filename.slice(0, dot)}-${id}${filename.slice(dot)}`;
    const next = {
      base64: photo.base64, contentType: photo.contentType,
      storagePath: `${photo.storagePath.slice(0, slash + 1)}${uniqueName}`, doc: { ...photo.doc, id },
    };
    assertPhoto(accountId, next);
    sizeOfBase64(next.base64);
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
      const legacySource = `${index}:${String(entry?.id ?? "unknown")}`;
      let op: PreparedOperation;
      try {
        if (!entry || typeof entry !== "object") throw new Error();
        const photo = entry.kind === "photo";
        const payload = photo ? entry.doc : entry.payload;
        const accountId = String(payload?.owner_id ?? "");
        op = photo ? preparePhoto(accountId, entry) : prepareInsert(accountId, String(entry.table), payload);
      } catch { invalid.push(entry); continue; }
      // Storage failures are retryable. Never quarantine a valid legacy entry on I/O failure.
      const items = groups.get(op.accountId) ?? await readUnlocked(op.accountId);
      groups.set(op.accountId, items);
      if (items.some(item => item.legacySource === legacySource)) continue;
      if (items.some(item => item.id === op.id)) { invalid.push(entry); continue; }
      op.legacySource = legacySource;
      op.status = "failed";
      op.error = "Recovered from an older app version. Check for an existing record before retrying; older changes had no duplicate protection.";
      items.push(op.kind === "photo" ? await persistPhoto(op) : op);
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

  const put = (op: PreparedOperation) => lock(async () => {
    await migrateLegacy();
    assertOperation(op, op.accountId);
    const existing = await readUnlocked(op.accountId);
    if (existing.some(item => item.id === op.id)) throw new Error("A change with this ID is already waiting to sync.");
    if (op.kind === "insert") return write(op.accountId, [...existing, op]);
    try {
      const reference = await persistPhoto(op);
      await write(op.accountId, [...existing, reference]);
    } catch (error) {
      cleaned.delete(op.accountId); // Recheck the authoritative queue before removing any file.
      throw error;
    }
  });

  const modify = (accountId: string, id: string, transform: (item: QueuedOp) => QueuedOp | null, revision?: number) => lock(async () => {
    assertAccount(accountId);
    const items = await readUnlocked(accountId);
    const index = items.findIndex((item) => item.id === id && (revision === undefined || item.revision === revision));
    if (index < 0) return null;
    const previous = items[index];
    const next = transform(previous);
    if (next) items[index] = next; else items.splice(index, 1);
    await write(accountId, items);
    if (!next && previous.kind === "photo") {
      try { await photoStorage().remove(previous.photoKey); }
      catch { cleaned.delete(accountId); } // Retry on next read after the durable acknowledgement.
    }
    return next;
  });

  return {
    prepareInsert, preparePhoto, read, put,
    async readPhoto(photo: QueuedPhoto): Promise<ArrayBuffer> {
      const bytes = await photoStorage().read(photo.photoKey);
      if (bytes.byteLength !== photo.byteLength) throw new Error("The saved photo is incomplete. Discard it and choose the photo again.");
      return bytes;
    },
    clearAccount: (accountId: string) => lock(async () => {
      assertAccount(accountId);
      try {
        await migrateLegacy();
      } finally {
        // Even an unreadable legacy queue must not retain this deleted account's scoped captures.
        await storage.removeItem(key(accountId));
        cleaned.delete(accountId);
        if (photos) for (const file of await photos.list(accountId)) await photos.remove(file);
      }
    }),
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
  upload(photo: QueuedPhoto, bytes: ArrayBuffer): Promise<void>;
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

export async function replayOperation(op: QueuedOp, transport: OfflineTransport, store: OfflineStore): Promise<void> {
  if (op.kind === "insert") return insertIdempotently(transport, op.table, op.payload);
  await transport.upload(op, await store.readPhoto(op));
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
      await replayOperation(op, transport, store);
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
