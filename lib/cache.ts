import AsyncStorage from "@react-native-async-storage/async-storage";

// Last-known-good read cache so lists/details stay browsable offline.
// On a successful query we persist the result; on failure we fall back to it.

const PREFIX = "rentview.cache.v1.";
const k = (key: string) => PREFIX + key;

/**
 * Run a Supabase select. On success, cache the rows and return them.
 * On any failure (typically offline), return the last cached value, or null.
 */
export async function cachedSelect<T>(
  key: string,
  builder: PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T | null> {
  try {
    const { data, error } = await builder;
    if (error) throw error;
    await AsyncStorage.setItem(k(key), JSON.stringify(data ?? null));
    return (data ?? null) as T | null;
  } catch {
    const raw = await AsyncStorage.getItem(k(key));
    return raw != null ? (JSON.parse(raw) as T) : null;
  }
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(k(key), JSON.stringify(value));
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const raw = await AsyncStorage.getItem(k(key));
  return raw != null ? (JSON.parse(raw) as T) : null;
}

/** Clear all cached reads (e.g. on sign-out, to avoid cross-account leakage). */
export async function clearCache(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  const ours = keys.filter((key) => key.startsWith(PREFIX));
  if (ours.length) await AsyncStorage.multiRemove(ours);
}
