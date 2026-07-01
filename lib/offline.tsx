import NetInfo from "@react-native-community/netinfo";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  enqueueInsert,
  getQueue,
  isNetworkError,
  removeFromQueue,
} from "./offlineQueue";
import { supabase } from "./supabase";

type SubmitResult = "inserted" | "queued";

type OfflineContextValue = {
  online: boolean;
  pendingCount: number;
  syncing: boolean;
  /** Insert now if online, otherwise queue for later. */
  submitInsert: (
    table: string,
    payload: Record<string, unknown>,
  ) => Promise<SubmitResult>;
  /** Attempt to flush the queue. Returns number of items synced. */
  sync: () => Promise<number>;
};

const OfflineContext = createContext<OfflineContextValue | undefined>(undefined);

export function OfflineProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);

  const refreshPending = useCallback(async () => {
    setPendingCount((await getQueue()).length);
  }, []);

  const sync = useCallback(async (): Promise<number> => {
    if (syncingRef.current) return 0;
    syncingRef.current = true;
    setSyncing(true);
    let synced = 0;
    try {
      const items = await getQueue();
      for (const item of items) {
        try {
          const { error } = await supabase
            .from(item.table as never)
            .insert(item.payload as never);
          if (error) {
            if (isNetworkError(error)) break; // still offline — stop, keep the rest
            // A real (non-network) error: drop it so it can't wedge the queue.
            await removeFromQueue(item.id);
            continue;
          }
          await removeFromQueue(item.id);
          synced += 1;
        } catch (e) {
          if (isNetworkError(e)) break;
          await removeFromQueue(item.id);
        }
      }
    } finally {
      await refreshPending();
      setSyncing(false);
      syncingRef.current = false;
    }
    return synced;
  }, [refreshPending]);

  // Track connectivity; flush the queue when we come back online.
  useEffect(() => {
    refreshPending();
    const unsubscribe = NetInfo.addEventListener((state) => {
      const isOnline = state.isConnected !== false;
      setOnline(isOnline);
      if (isOnline) sync();
    });
    return () => unsubscribe();
  }, [refreshPending, sync]);

  const submitInsert = useCallback(
    async (
      table: string,
      payload: Record<string, unknown>,
    ): Promise<SubmitResult> => {
      if (!online) {
        await enqueueInsert(table, payload);
        await refreshPending();
        return "queued";
      }
      try {
        const { error } = await supabase
          .from(table as never)
          .insert(payload as never);
        if (error) {
          if (isNetworkError(error)) {
            await enqueueInsert(table, payload);
            await refreshPending();
            return "queued";
          }
          throw error;
        }
        return "inserted";
      } catch (e) {
        if (isNetworkError(e)) {
          await enqueueInsert(table, payload);
          await refreshPending();
          return "queued";
        }
        throw e;
      }
    },
    [online, refreshPending],
  );

  return (
    <OfflineContext.Provider
      value={{ online, pendingCount, syncing, submitInsert, sync }}
    >
      {children}
    </OfflineContext.Provider>
  );
}

export function useOffline() {
  const ctx = useContext(OfflineContext);
  if (!ctx) throw new Error("useOffline must be used within an OfflineProvider");
  return ctx;
}
