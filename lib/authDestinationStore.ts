import { safeReturnPath } from "./invites";

export type DestinationStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};
const KEY = "rentview.auth.destination.v1";
const MAX_AGE = 24 * 60 * 60 * 1000;

/** A short-lived onboarding destination; stored values are revalidated before use. */
export function createAuthDestinationStore(storage: DestinationStorage, now = Date.now) {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const operation = tail.then(task, task);
    tail = operation.catch(() => undefined);
    return operation;
  };
  return {
    remember(path: string): Promise<void> {
      return serial(async () => {
      const safe = safeReturnPath(path);
      if (safe === "/") {
        await storage.removeItem(KEY);
        return;
      }
      await storage.setItem(KEY, JSON.stringify({ path: safe, at: now() }));
      });
    },
    pending(): Promise<string> {
      return serial(async () => {
      try {
        const raw = await storage.getItem(KEY);
        if (!raw) return "/";
        if (raw.length > 4096) {
          await storage.removeItem(KEY);
          return "/";
        }
        const value = JSON.parse(raw) as { path?: unknown; at?: unknown } | null;
        const currentTime = now();
        if (typeof value?.at !== "number" || !Number.isFinite(value.at) || value.at > currentTime || currentTime - value.at > MAX_AGE) {
          await storage.removeItem(KEY);
          return "/";
        }
        const safe = safeReturnPath(value.path);
        if (safe === "/") await storage.removeItem(KEY);
        return safe;
      } catch {
        // Corrupt or unavailable local storage must never become a redirect.
        await storage.removeItem(KEY).catch(() => undefined);
        return "/";
      }
      });
    },
    clear(): Promise<void> {
      return serial(() => storage.removeItem(KEY));
    },
  };
}
