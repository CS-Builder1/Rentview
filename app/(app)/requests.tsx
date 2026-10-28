import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Badge, Button, Card, EmptyState, Field, Loading, Screen } from "../../components/ui";
import { cachedSelectResult } from "../../lib/cache";
import type { Tables } from "../../lib/database.types";
import { formatDate, titleCase } from "../../lib/format";
import { supabase } from "../../lib/supabase";
import { readAllPages } from "../../lib/operationsQuery";

type RequestRow = Tables<"maintenance_requests"> & {
  properties: { name: string } | null;
  units: { label: string } | null;
};

/** Anything the owner still owes the tenant an answer on. */
const OPEN_STATUSES = ["submitted", "acknowledged", "in_progress"] as const;

export default function Requests() {
  const router = useRouter();
  const params = useLocalSearchParams<{ filter?: string; propertyId?: string }>();
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [showAll, setShowAll] = useState(params.filter === "all");

  const load = useCallback(async () => {
    const result = await cachedSelectResult<RequestRow[]>(
      "requests",
      readAllPages<RequestRow>((from, to) => supabase
        .from("maintenance_requests")
        .select("*, properties!maintenance_requests_property_id_owner_fk(name), units!maintenance_requests_unit_property_owner_fk(label)", { count: "exact" })
        .order("created_at", { ascending: false }).order("id").range(from, to)),
    );
    setError(result.error);
    setRequests(result.data ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!requests) return <Loading />;

  const openCount = requests.filter((r) =>
    (OPEN_STATUSES as readonly string[]).includes(r.status),
  ).length;
  const visible = requests.filter((r) =>
    (showAll || (OPEN_STATUSES as readonly string[]).includes(r.status)) &&
    (params.filter !== "submitted" || r.status === "submitted") &&
    (!params.propertyId || r.property_id === params.propertyId) &&
    `${r.title} ${r.properties?.name ?? ""} ${r.units?.label ?? ""}`.toLowerCase().includes(search.toLowerCase())
  ).sort((a, b) => Number(b.urgency === "urgent") - Number(a.urgency === "urgent") || a.created_at.localeCompare(b.created_at));

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/more")
          }
          className="p-2"
        >
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text className="flex-1 text-xl font-bold text-slate-900">
          Tenant requests
        </Text>
      </View>

      <View className="px-5"><Field label="Search requests" value={search} onChangeText={setSearch} placeholder="Title, property or unit" />{error ? <><Text accessibilityRole="alert" className="mb-2 text-red-700">{error}</Text><Button title="Retry" variant="secondary" onPress={() => void load()} /></> : null}</View>
      <View className="flex-row px-5 pb-3">
        {[
          { key: false, label: `Open (${openCount})` },
          { key: true, label: `All (${requests.length})` },
        ].map((tab) => (
          <Pressable
            key={String(tab.key)}
            onPress={() => { setShowAll(tab.key); if (params.filter === "submitted") router.setParams({ filter: "active" }); }}
            className={`mr-2 rounded-full border px-3 py-1.5 ${
              showAll === tab.key
                ? "border-brand bg-brand"
                : "border-slate-300 bg-white"
            }`}
          >
            <Text
              className={
                showAll === tab.key ? "font-medium text-white" : "text-slate-700"
              }
            >
              {tab.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        {visible.length === 0 && !error ? (
          <EmptyState
            title={showAll ? "No requests yet" : "Nothing open"}
            subtitle={
              showAll
                ? "Tenants you invite to the portal can report repairs here."
                : "Every tenant request has been resolved or closed."
            }
          />
        ) : (
          visible.map((r) => (
            <Card key={r.id} onPress={() => router.push(`/request/${r.id}`)}>
              <View className="flex-row items-start justify-between">
                <Text className="flex-1 pr-2 text-base font-semibold text-slate-900">
                  {r.title}
                </Text>
                <Badge label={r.status} />
              </View>
              <Text className="mt-1 text-slate-500">
                {[r.properties?.name, r.units?.label].filter(Boolean).join(" · ")}
              </Text>
              <View className="mt-2 flex-row items-center">
                <Badge label={r.urgency} />
                <Text className="ml-2 text-xs text-slate-400">
                  {titleCase(r.category)} · {formatDate(r.created_at)}
                  {r.work_order_id ? " · work order raised" : ""}
                </Text>
              </View>
            </Card>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}
