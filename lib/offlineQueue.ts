import AsyncStorage from "@react-native-async-storage/async-storage";

// A durable queue of mutations captured while offline, replayed on reconnect.
//   - "insert": a plain row payload for a table.
//   - "photo":  image bytes (base64) to upload to Storage, then a documents row.

const STORAGE_KEY = "rentview.offline.queue.v1";

export type QueuedInsert = {
  id: string;
  kind: "insert";
  table: string;
  payload: Record<string, unknown>;
  createdAt: number;
};

export type QueuedPhoto = {
  id: string;
  kind: "photo";
  base64: string;
  contentType: string;
  storagePath: string;
  doc: Record<string, unknown>; // documents row (minus storage/mime/size)
  createdAt: number;
};

export type QueuedOp = QueuedInsert | QueuedPhoto;

export async function getQueue(): Promise<QueuedOp[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    // Tolerate older entries that predate the `kind` field.
    return parsed.map((op) =>
      "kind" in op ? op : { ...op, kind: "insert" },
    ) as QueuedOp[];
  } catch {
    return [];
  }
}

async function writeQueue(items: QueuedOp[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function enqueueInsert(
  table: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const items = await getQueue();
  items.push({ id: newId(), kind: "insert", table, payload, createdAt: Date.now() });
  await writeQueue(items);
}

export async function enqueuePhoto(
  op: Omit<QueuedPhoto, "id" | "kind" | "createdAt">,
): Promise<void> {
  const items = await getQueue();
  items.push({ ...op, id: newId(), kind: "photo", createdAt: Date.now() });
  await writeQueue(items);
}

export async function removeFromQueue(id: string): Promise<void> {
  const items = await getQueue();
  await writeQueue(items.filter((i) => i.id !== id));
}

/** Heuristic: does this failure look like a connectivity problem (vs a real error)? */
export function isNetworkError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err ?? "");
  return /network request failed|failed to fetch|load failed|fetch failed|networkerror|timeout/i.test(
    msg,
  );
}
