import type { PhotoStorage } from "./photoStorage";

const STORE = "photos";

async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("rentview.offline.photos.v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = operation(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error ?? new Error("Offline photo storage was interrupted."));
    });
  } finally {
    db.close();
  }
}

export const offlinePhotos: PhotoStorage = {
  async write(key, bytes) {
    await transact("readwrite", store => store.put(new Blob([bytes]), key));
  },
  async read(key) {
    const blob = await transact("readonly", store => store.get(key));
    if (!(blob instanceof Blob)) throw new Error("The saved photo is missing from this device.");
    return blob.arrayBuffer();
  },
  async remove(key) {
    await transact("readwrite", store => store.delete(key));
  },
  async list(accountId) {
    const keys = await transact("readonly", store => store.getAllKeys(IDBKeyRange.bound(accountId + "/", accountId + "/\uffff")));
    return keys.map(String);
  },
};
