import NetInfo from "@react-native-community/netinfo";
import { decode } from "base64-arraybuffer";
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
  enqueuePhoto,
  getQueue,
  isNetworkError,
  removeFromQueue,
} from "./offlineQueue";
import { supabase } from "./supabase";

type SubmitResult = "inserted" | "queued";

export type PhotoSubmission = {
  base64: string;
  contentType: string;
  storagePath: string;
  doc: Record<string, unknown>;
};

async function uploadPhoto(op: {
  base64: string;
  contentType: string;
  storagePath: string;
  doc: Record<string, unknown>;
}): Promise<void> {
  const bytes = decode(op.base64);
  const { error: upErr } = await supabase.storage
    .from("attachments")
    .upload(op.storagePath, bytes, {
      contentType: op.contentType,
      upsert: true, // idempotent so retries after a partial failure are safe
    });
  if (upErr) throw upErr;
  const { error: docErr } = await supabase.from("documents").insert({
    ...op.doc,
    storage_path: op.storagePath,
    mime_type: op.contentType,
    size_bytes: bytes.byteLength,
  } as never);
  if (docErr) throw docErr;
}

type OfflineContextValue = {
  online: boolean;
  pendingCount: number;
  syncing: boolean;
  /** Insert now if online, otherwise queue for later. */
  submitInsert: (
    table: string,
    payload: Record<string, unknown>,
  ) => Promise<SubmitResult>;
  /** Upload a photo now if online, otherwise queue it. */
  submitPhoto: (photo: PhotoSubmission) => Promise<SubmitResult>;
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
          if (item.kind === "photo") {
            await uploadPhoto(item);
          } else {
            const { error } = await supabase
              .from(item.table as never)
              .insert(item.payload as never);
            if (error) throw error;
          }
          await removeFromQueue(item.id);
          synced += 1;
        } catch (e) {
          if (isNetworkError(e)) break; // still offline — stop, keep the rest
          // A real (non-network) error: drop it so it can't wedge the queue.
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

  const submitPhoto = useCallback(
    async (photo: PhotoSubmission): Promise<SubmitResult> => {
      if (!online) {
        await enqueuePhoto(photo);
        await refreshPending();
        return "queued";
      }
      try {
        await uploadPhoto(photo);
        return "inserted";
      } catch (e) {
        if (isNetworkError(e)) {
          await enqueuePhoto(photo);
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
      value={{ online, pendingCount, syncing, submitInsert, submitPhoto, sync }}
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
