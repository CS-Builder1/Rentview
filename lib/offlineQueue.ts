import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { newRecordId } from "./id";
import { createOfflineStore } from "./offlineStore";

export * from "./offlineStore";

/** One serialized storage writer for every account on this device. */
export const offlineStore = createOfflineStore(AsyncStorage, newRecordId, Date.now, async (work) => {
  if (Platform.OS !== "web") return work();
  if (typeof navigator === "undefined" || !navigator.locks) {
    throw new Error("Offline saving needs a secure browser connection. Open RentView using HTTPS in a current browser, or use the mobile app.");
  }
  // AsyncStorage's web implementation uses localStorage. Share the lock across tabs,
  // not only across simultaneous callbacks in this React tree.
  return navigator.locks.request("rentview.offline.queue.v2", work);
});
