import type { QueueStorage } from "./offlineStore";

export type CachedResult<T> = {
  data: T | null;
  error: string | null;
  stale: boolean;
  updatedAt: number | null;
  source: "network" | "cache" | "none";
};
export type CacheNotice = { key: string; message: string; updatedAt: number | null; stale: boolean };
const PREFIX = "rentview.cache.v2.";

function message(error: unknown): string {
  return error instanceof Error ? error.message
    : typeof error === "object" && error && "message" in error ? String(error.message)
      : "Could not refresh this information.";
}

function authorizationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const status = "status" in error ? Number(error.status) : null;
  // RLS-hidden rows normally look absent, rather than returning a permission error.
  // A single-row query reports that absence as PGRST116; never restore its old data.
  return ["42501", "PGRST116", "PGRST301", "PGRST302", "PGRST303"].includes(code) || status === 401 || status === 403;
}

/** A read result belongs to the account/generation that started it, even after await. */
export function createReadCache(storage: QueueStorage, now = Date.now) {
  let accountId: string | null = null;
  let generation = 0;
  let notices = new Map<string, CacheNotice>();
  const subscribers = new Set<() => void>();
  const emit = () => subscribers.forEach((fn) => fn());
  const capture = () => ({ accountId, generation });
  const current = (scope: ReturnType<typeof capture>) => scope.accountId !== null && scope.accountId === accountId && scope.generation === generation;
  const key = (owner: string, name: string) => `${PREFIX}${owner}.${name}`;
  const accountChanged = <T>(): CachedResult<T> => ({ data: null, error: "Your account changed. Reload this screen.", stale: false, updatedAt: null, source: "none" });

  async function read<T>(owner: string, name: string): Promise<{ data: T | null; updatedAt: number } | null> {
    try {
      const raw = await storage.getItem(key(owner, name));
      if (raw === null) return null;
      const value = JSON.parse(raw);
      return value && typeof value.updatedAt === "number" && "data" in value ? value : null;
    } catch { return null; }
  }

  return {
    setAccount(next: string | null): void {
      if (next === accountId) return;
      accountId = next;
      generation += 1;
      notices = new Map();
      emit();
    },
    getAccount: () => accountId,
    subscribe(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; },
    getNotices: (): CacheNotice[] => [...notices.values()],
    async query<T>(name: string, builder: PromiseLike<{ data: unknown; error: unknown }>): Promise<CachedResult<T>> {
      const scope = capture();
      if (!scope.accountId) return accountChanged();
      try {
        const { data, error } = await builder;
        if (!current(scope)) return accountChanged();
        if (error) throw error;
        const updatedAt = now();
        try { await storage.setItem(key(scope.accountId, name), JSON.stringify({ data: data ?? null, updatedAt })); }
        catch { /* A cache quota failure must not mislabel a successful server read. */ }
        if (!current(scope)) return accountChanged();
        if (notices.delete(name)) emit();
        return { data: (data ?? null) as T | null, error: null, stale: false, updatedAt, source: "network" };
      } catch (error) {
        if (!current(scope)) return accountChanged();
        const denied = authorizationFailure(error);
        let cached: { data: T | null; updatedAt: number } | null = null;
        if (denied) await storage.removeItem(key(scope.accountId, name)).catch(() => undefined);
        else cached = await read<T>(scope.accountId, name);
        if (!current(scope)) return accountChanged();
        const text = denied ? "Access could not be verified. Sign in again or contact the property owner." : message(error);
        notices.set(name, { key: name, message: text, stale: cached !== null, updatedAt: cached?.updatedAt ?? null });
        emit();
        return { data: cached?.data ?? null, error: text, stale: cached !== null, updatedAt: cached?.updatedAt ?? null, source: cached ? "cache" : "none" };
      }
    },
    async set(name: string, value: unknown): Promise<void> {
      const scope = capture();
      if (!scope.accountId) return;
      await storage.setItem(key(scope.accountId, name), JSON.stringify({ data: value, updatedAt: now() }));
    },
    async get<T>(name: string): Promise<T | null> {
      const scope = capture();
      if (!scope.accountId) return null;
      const cached = await read<T>(scope.accountId, name);
      return current(scope) ? cached?.data ?? null : null;
    },
  };
}
