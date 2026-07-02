import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { SkeletonList } from "../../components/Skeleton";
import { Badge, Card, EmptyState, Icon, Screen } from "../../components/ui";
import { cachedSelect } from "../../lib/cache";
import type { Tables } from "../../lib/database.types";
import { formatDate } from "../../lib/format";
import { supabase } from "../../lib/supabase";

type Request = Tables<"maintenance_requests"> & {
  properties: { name: string } | null;
  units: { label: string } | null;
  leases: { tenant_name: string } | null;
};

const OPEN_STATUSES = ["submitted", "acknowledged", "in_progress"] as const;

export default function RequestsInbox() {
  const router = useRouter();
  const [requests, setRequests] = useState<Request[] | null>(null);
  const [filter, setFilter] = useState<"open" | "all">("open");

  const load = useCallback(async () => {
    const rows = await cachedSelect<Request[]>(
      "owner.requests",
      supabase
        .from("maintenance_requests")
        .select("*, properties(name), units(label), leases(tenant_name)")
        .order("created_at", { ascending: false }),
    );
    setRequests(rows ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const visible = (requests ?? []).filter((r) =>
    filter === "all" ? true : (OPEN_STATUSES as readonly string[]).includes(r.status),
  );
  const newCount = (requests ?? []).filter((r) => r.status === "submitted").length;
  const ratings = (requests ?? []).filter((r) => r.rating != null);
  const avgRating =
    ratings.length > 0
      ? ratings.reduce((sum, r) => sum + (r.rating ?? 0), 0) / ratings.length
      : null;

  return (
    <Screen>
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable onPress={() => router.back()} className="p-1 pr-3">
          <Icon name="chevron-back" size={24} />
        </Pressable>
        <Text className="flex-1 text-xl font-bold text-slate-900 dark:text-slate-100">
          Tenant requests
        </Text>
        {newCount > 0 ? (
          <View className="rounded-full bg-brand px-2.5 py-0.5">
            <Text className="text-xs font-bold text-white">{newCount} new</Text>
          </View>
        ) : null}
      </View>

      {avgRating != null ? (
        <View className="flex-row items-center px-5 pb-1">
          <Icon name="star" size={14} tone="warning" />
          <Text className="ml-1 text-sm text-slate-500 dark:text-slate-400">
            {avgRating.toFixed(1)} average repair rating from {ratings.length} review
            {ratings.length === 1 ? "" : "s"}
          </Text>
        </View>
      ) : null}

      <View className="flex-row px-5 pb-2">
        {(["open", "all"] as const).map((f) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            className={`mr-2 rounded-full border px-3 py-1.5 ${
              filter === f
                ? "border-brand bg-brand"
                : "border-slate-300 bg-white dark:border-slate-700 dark:bg-surface-dark"
            }`}
          >
            <Text
              className={
                filter === f ? "text-sm font-medium text-white" : "text-sm text-slate-700 dark:text-slate-200"
              }
            >
              {f === "open" ? "Open" : "All"}
            </Text>
          </Pressable>
        ))}
      </View>

      {!requests ? (
        <SkeletonList />
      ) : (
        <ScrollView contentContainerClassName="px-5 pb-10">
          {visible.length === 0 ? (
            <EmptyState
              icon="chatbubbles-outline"
              title={filter === "open" ? "No open requests" : "No requests yet"}
              subtitle="When tenants report a problem from their portal, it lands here."
            />
          ) : (
            visible.map((r) => (
              <Card key={r.id} onPress={() => router.push(`/request/${r.id}`)}>
                <View className="flex-row items-center justify-between">
                  <Text className="flex-1 pr-2 text-base font-semibold text-slate-900 dark:text-slate-100">
                    {r.title}
                  </Text>
                  <Badge label={r.status} />
                </View>
                <Text className="mt-1 text-slate-500 dark:text-slate-400">
                  {r.leases?.tenant_name ?? "Tenant"} · {r.properties?.name ?? "—"}
                  {r.units?.label ? ` · ${r.units.label}` : ""}
                </Text>
                <View className="mt-2 flex-row items-center justify-between">
                  <Badge label={r.urgency} />
                  <Text className="text-xs text-slate-400 dark:text-slate-500">
                    {formatDate(r.created_at)}
                  </Text>
                </View>
              </Card>
            ))
          )}
        </ScrollView>
      )}
    </Screen>
  );
}
