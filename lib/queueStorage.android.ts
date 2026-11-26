import AsyncStorage from "@react-native-async-storage/async-storage";
import { readLegacyQueueRow } from "./legacyQueueRow";
import type { QueueStorage } from "./offlineStore";

export const queueStorage: QueueStorage = {
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: key => AsyncStorage.removeItem(key),
  async getItem(key) {
    try { return await AsyncStorage.getItem(key); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/CursorWindow|SQLiteBlobTooBig/i.test(message)) throw error;
      // Expo SQLite uses Context.filesDir/SQLite; Android SQLiteOpenHelper uses
      // Context.getDatabasePath("RKStorage"), the sibling databases directory.
      const { defaultDatabaseDirectory, openDatabaseAsync } = await import("expo-sqlite");
      const directory = defaultDatabaseDirectory.replace(/\/files\/SQLite\/?$/, "/databases");
      if (directory === defaultDatabaseDirectory) throw error;
      const db = await openDatabaseAsync("RKStorage", { useNewConnection: true }, directory);
      try {
        await db.execAsync("PRAGMA query_only = ON");
        let raw = "";
        await db.withTransactionAsync(async () => {
          raw = await readLegacyQueueRow(key, (sql, ...args) => db.getFirstAsync(sql, args));
        });
        return raw;
      } finally { await db.closeAsync(); }
    }
  },
};
