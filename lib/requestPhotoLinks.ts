export type RequestPhoto = { id: string; storage_path: string };
export type ResolvedRequestPhoto = { id: string; url: string | null };
type CachedLink = { path: string; url: string | null; refreshAt: number };

/** Keep this resolver inside one account/request lifetime, never in persistent storage. */
export function createRequestPhotoLinks(now = Date.now) {
  const links = new Map<string, CachedLink>();
  return {
    retryUnavailable(): void {
      for (const [id, link] of links) if (link.url === null) links.delete(id);
    },
    async resolve(photos: RequestPhoto[], sign: (path: string, seconds: number) => Promise<string | null>): Promise<ResolvedRequestPhoto[]> {
      const present = new Set(photos.map(photo => photo.id));
      for (const id of links.keys()) if (!present.has(id)) links.delete(id);
      return Promise.all(photos.map(async photo => {
        const cached = links.get(photo.id);
        if (cached?.path === photo.storage_path && now() < cached.refreshAt) return { id: photo.id, url: cached.url };
        // A broken/missing object must not reject the other photos or messages.
        // Start expiry before signing so request latency cannot extend validity.
        const startedAt = now();
        const url = await sign(photo.storage_path, 60).catch(() => null);
        // Refresh healthy links before expiry, and bound automatic missing-file
        // retries. An explicit refresh can retry unavailable photos immediately.
        links.set(photo.id, { path: photo.storage_path, url, refreshAt: startedAt + (url ? 45_000 : 30_000) });
        return { id: photo.id, url };
      }));
    },
  };
}
