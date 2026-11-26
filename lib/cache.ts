import AsyncStorage from "@react-native-async-storage/async-storage";

import { createReadCache } from "./cacheStore";

export type { CachedResult, CacheNotice } from "./cacheStore";
export const readCache = createReadCache(AsyncStorage);
export const setCacheAccount = readCache.setAccount;

/** Prefer this result when a screen needs to distinguish empty, stale and failed. */
export const cachedSelectResult = readCache.query;

/** Existing screens remain compatible; a shared banner also exposes failed/stale reads. */
export async function cachedSelect<T>(key: string, builder: PromiseLike<{ data: unknown; error: unknown }>): Promise<T | null> {
  return (await readCache.query<T>(key, builder)).data;
}

export const cacheSet = readCache.set;
export const cacheGet = readCache.get;

/** Clear only reads, never captured work. Pending operations remain in their original account. */
export async function clearCache(accountId?: string): Promise<void> {
  const owner = accountId ?? readCache.getAccount();
  const keys = await AsyncStorage.getAllKeys();
  const ours = keys.filter((key) => key.startsWith("rentview.cache.v1.") ||
    (owner ? key.startsWith(`rentview.cache.v2.${owner}.`) : false));
  if (ours.length) await AsyncStorage.multiRemove(ours);
}
