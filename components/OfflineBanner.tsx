import { Ionicons } from "@expo/vector-icons";
import { Pressable, Text, View } from "react-native";

import { useOffline } from "../lib/offline";

/** Thin status strip shown when offline or when changes are waiting to sync. */
export function OfflineBanner() {
  const { online, pendingCount, syncing, sync } = useOffline();

  if (online && pendingCount === 0) return null;

  const bg = online ? "bg-amber-500" : "bg-slate-700";
  const label = !online
    ? pendingCount > 0
      ? `Offline · ${pendingCount} change${pendingCount === 1 ? "" : "s"} waiting`
      : "Offline · changes will be saved and synced"
    : syncing
      ? "Syncing…"
      : `${pendingCount} change${pendingCount === 1 ? "" : "s"} waiting to sync`;

  return (
    <View className={`flex-row items-center justify-between px-4 py-1.5 ${bg}`}>
      <View className="flex-row items-center">
        <Ionicons
          name={online ? "cloud-upload-outline" : "cloud-offline-outline"}
          size={14}
          color="#fff"
        />
        <Text className="ml-2 text-xs font-medium text-white">{label}</Text>
      </View>
      {online && pendingCount > 0 ? (
        <Pressable onPress={() => sync()} disabled={syncing}>
          <Text className="text-xs font-semibold text-white underline">
            Sync now
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
