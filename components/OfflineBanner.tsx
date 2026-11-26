import { Ionicons } from "@expo/vector-icons";
import { usePathname, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { readCache } from "../lib/cache";
import { useOffline } from "../lib/offline";

/** Saved work and stale information stay visible until the underlying issue is resolved. */
export function OfflineBanner() {
  const router = useRouter();
  const pathname = usePathname();
  const { online, pendingCount, failedCount, syncing, sync, storageError, hasQuarantinedChanges } = useOffline();
  const [notices, setNotices] = useState(readCache.getNotices);
  useEffect(() => readCache.subscribe(() => setNotices(readCache.getNotices())), []);
  const needsAttention = Boolean(storageError || failedCount || hasQuarantinedChanges);
  if (online && !pendingCount && !notices.length && !needsAttention) return null;
  const label = storageError ? "Saved changes need attention"
    : failedCount ? `${failedCount} saved change${failedCount === 1 ? " needs" : "s need"} attention`
      : hasQuarantinedChanges ? "Older saved changes need recovery"
        : syncing ? "Syncing saved changes…"
          : pendingCount ? `${online ? "" : "Offline · "}${pendingCount} saved change${pendingCount === 1 ? "" : "s"} waiting to sync`
            : notices.length ? "Some information could not be refreshed"
              : "Offline · showing available saved information";
  return (
    <View accessibilityLiveRegion="polite" className={`px-4 py-2 ${needsAttention ? "bg-red-700" : online ? "bg-amber-700" : "bg-slate-700"}`}>
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-1 flex-row items-center">
          <Ionicons name={needsAttention ? "alert-circle-outline" : online ? "cloud-upload-outline" : "cloud-offline-outline"} size={16} color="#fff" />
          <Text className="ml-2 flex-1 text-xs font-medium text-white">{label}</Text>
        </View>
        {pathname !== "/sync" && (pendingCount > 0 || notices.length > 0 || needsAttention) ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Review saved changes and refresh problems" onPress={() => router.push("/sync")} className="py-1">
            <Text className="text-xs font-semibold text-white underline">Review</Text>
          </Pressable>
        ) : null}
        {online && pendingCount > failedCount ? (
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: syncing, busy: syncing }} onPress={() => void sync()} disabled={syncing} className="py-1">
            <Text className="text-xs font-semibold text-white underline">Sync now</Text>
          </Pressable>
        ) : null}
      </View>
      {notices.some((notice) => notice.stale) ? <Text className="mt-1 text-xs text-white">Saved information may be out of date. Open the screen again to refresh.</Text> : null}
    </View>
  );
}
