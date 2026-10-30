import NetInfo from "@react-native-community/netinfo";
import { decode } from "base64-arraybuffer";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { useAuth } from "./auth";
import {
  errorMessage, flushOfflineQueue, offlineStore, type OfflineTransport, type PhotoSubmission, type QueuedOp,
} from "./offlineQueue";
import { supabase } from "./supabase";
import { assertStoragePath, inspectImage } from "./uploadPolicy";

export type { PhotoSubmission } from "./offlineStore";
type SubmitResult = "inserted" | "queued";

const transport: OfflineTransport = {
  async insert(table, payload) {
    return supabase.from(table as never).insert(payload as never);
  },
  async find(table, id) {
    const result = await supabase.from(table as never).select("*").eq("id", id).maybeSingle();
    return { data: result.data as Record<string, unknown> | null, error: result.error };
  },
  async upload(photo) {
    assertStoragePath(photo.storagePath);
    const bytes = decode(photo.base64);
    const detected = inspectImage(new Uint8Array(bytes));
    if (detected.mimeType !== photo.contentType) throw new Error("The saved photo does not match its image type. Discard it and choose the photo again.");
    const { error } = await supabase.storage.from("attachments").upload(photo.storagePath, bytes, {
      contentType: photo.contentType,
      // An operation owns a UUID-specific object path. A retry replaces only its own bytes.
      upsert: true,
    });
    if (error) throw error;
  },
  documentPayload(photo) {
    return {
      ...photo.doc, storage_path: photo.storagePath, mime_type: photo.contentType,
      size_bytes: decode(photo.base64).byteLength,
    };
  },
};

type OfflineContextValue = {
  online: boolean;
  pendingCount: number;
  failedCount: number;
  syncing: boolean;
  operations: QueuedOp[];
  storageError: string | null;
  hasQuarantinedChanges: boolean;
  submitInsert: (table: string, payload: Record<string, unknown>) => Promise<SubmitResult>;
  submitPhoto: (photo: PhotoSubmission) => Promise<SubmitResult>;
  sync: () => Promise<number>;
  refresh: () => Promise<void>;
  retryOperation: (id: string) => Promise<void>;
  discardOperation: (id: string) => Promise<void>;
  editOperation: (id: string, payload: Record<string, unknown>) => Promise<void>;
};

const OfflineContext = createContext<OfflineContextValue | undefined>(undefined);

export function OfflineProvider({ children }: { children: ReactNode }) {
  const { session, initializing } = useAuth();
  const accountId = session?.user.id ?? null;
  const [online, setOnline] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [snapshot, setSnapshot] = useState<{ accountId: string | null; operations: QueuedOp[]; error: string | null; quarantined: boolean }>({
    accountId: null, operations: [], error: null, quarantined: false,
  });
  const auth = useRef({ accountId, ready: Boolean(accountId && !initializing) });
  auth.current = { accountId, ready: Boolean(accountId && !initializing) };
  const alive = useRef(true);
  const onlineRef = useRef(false);
  const running = useRef<Promise<number> | null>(null);
  const rerun = useRef(false);

  const refresh = useCallback(async () => {
    const owner = auth.current.accountId;
    if (!owner) {
      if (alive.current) setSnapshot({ accountId: null, operations: [], error: null, quarantined: false });
      return;
    }
    try {
      const operations = await offlineStore.read(owner);
      const quarantined = await offlineStore.hasQuarantinedChanges();
      if (alive.current && auth.current.accountId === owner) setSnapshot({ accountId: owner, operations, error: null, quarantined });
    } catch (error) {
      if (alive.current && auth.current.accountId === owner) setSnapshot((last) => ({
        accountId: owner, operations: last.accountId === owner ? last.operations : [],
        error: errorMessage(error), quarantined: false,
      }));
    }
  }, []);

  const sync = useCallback((): Promise<number> => {
    if (running.current) {
      rerun.current = true;
      return running.current;
    }
    if (!alive.current || !auth.current.ready || !onlineRef.current) return Promise.resolve(0);
    setSyncing(true);
    const work = (async () => {
      let synced = 0;
      do {
        rerun.current = false;
        const owner = auth.current.accountId;
        if (!owner || !auth.current.ready || !onlineRef.current || !alive.current) break;
        synced += await flushOfflineQueue(offlineStore, transport, owner, () =>
          alive.current && onlineRef.current && auth.current.ready && auth.current.accountId === owner,
        );
      } while (rerun.current && alive.current);
      return synced;
    })().catch((error) => {
      const owner = auth.current.accountId;
      if (alive.current) setSnapshot((last) => ({
        accountId: owner, operations: last.accountId === owner ? last.operations : [],
        error: errorMessage(error), quarantined: last.accountId === owner && last.quarantined,
      }));
      return 0;
    }).finally(async () => {
      running.current = null;
      await refresh();
      if (alive.current) setSyncing(false);
    });
    running.current = work;
    return work;
  }, [refresh]);

  useEffect(() => {
    alive.current = true;
    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected = state.isConnected === true && state.isInternetReachable !== false;
      onlineRef.current = connected;
      setOnline(connected);
    });
    return () => { alive.current = false; onlineRef.current = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    void refresh();
    if (accountId && !initializing && online) void sync();
  }, [accountId, initializing, online, refresh, sync]);

  const submit = useCallback(async (operation: QueuedOp): Promise<SubmitResult> => {
    // Durable before the first HTTP request, including when the device appears online.
    await offlineStore.put(operation);
    await refresh();
    if (!auth.current.ready || auth.current.accountId !== operation.accountId) return "queued";
    if (onlineRef.current) await sync();
    const remaining = (await offlineStore.read(operation.accountId)).find((item) => item.id === operation.id);
    await refresh();
    if (!remaining) return "inserted";
    if (remaining.status === "failed") {
      throw new Error(`The change is saved on this device but could not sync: ${remaining.error ?? "Please review it."} Open Saved changes to edit, retry or discard it before saving again.`);
    }
    return "queued";
  }, [refresh, sync]);

  const requireAccount = useCallback(() => {
    const current = auth.current;
    if (!current.accountId || !current.ready) throw new Error("Wait for sign-in to finish before saving changes.");
    return current.accountId;
  }, []);

  const submitInsert = useCallback((table: string, payload: Record<string, unknown>) =>
    submit(offlineStore.prepareInsert(requireAccount(), table, payload)), [requireAccount, submit]);
  const submitPhoto = useCallback((photo: PhotoSubmission) =>
    submit(offlineStore.preparePhoto(requireAccount(), photo)), [requireAccount, submit]);

  const retryOperation = useCallback(async (id: string) => {
    const owner = requireAccount();
    await offlineStore.retry(owner, id);
    await refresh();
    if (onlineRef.current) await sync();
  }, [requireAccount, refresh, sync]);
  const discardOperation = useCallback(async (id: string) => {
    if (running.current) throw new Error("Wait for synchronization to finish before discarding a change.");
    await offlineStore.remove(requireAccount(), id);
    await refresh();
  }, [requireAccount, refresh]);
  const editOperation = useCallback(async (id: string, payload: Record<string, unknown>) => {
    if (running.current) throw new Error("Wait for synchronization to finish before editing a change.");
    await offlineStore.edit(requireAccount(), id, payload);
    await refresh();
    if (onlineRef.current) await sync();
  }, [requireAccount, refresh, sync]);

  // Never display another account's queue even for the render before the effect runs.
  const current = snapshot.accountId === accountId ? snapshot : null;
  const operations = current?.operations ?? [];
  return (
    <OfflineContext.Provider value={{
      online, syncing, operations, pendingCount: operations.length,
      failedCount: operations.filter((operation) => operation.status === "failed").length,
      storageError: current?.error ?? null, hasQuarantinedChanges: current?.quarantined ?? false,
      submitInsert, submitPhoto, sync, refresh, retryOperation, discardOperation, editOperation,
    }}>
      {children}
    </OfflineContext.Provider>
  );
}

export function useOffline() {
  const context = useContext(OfflineContext);
  if (!context) throw new Error("useOffline must be used within an OfflineProvider");
  return context;
}
