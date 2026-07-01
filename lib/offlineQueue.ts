import AsyncStorage from "@react-native-async-storage/async-storage";

// A durable queue of insert mutations captured while offline.
// Each entry is a plain row payload for a given table; it is replayed
// verbatim once connectivity returns.

const STORAGE_KEY = "rentview.offline.queue.v1";

export type QueuedInsert = {
  id: string; // local id
  table: string;
  payload: Record<string, unknown>;
  createdAt: number;
};

export async function getQueue(): Promise<QueuedInsert[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as QueuedInsert[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(items: QueuedInsert[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

export async function enqueueInsert(
  table: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const items = await getQueue();
  items.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    table,
    payload,
    createdAt: Date.now(),
  });
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
