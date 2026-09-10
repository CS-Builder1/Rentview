import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Badge, Card, EmptyState, Loading, Screen } from "../../../components/ui";
import { cachedSelect } from "../../../lib/cache";
import type { Tables } from "../../../lib/database.types";
import { formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";

export default function TenantRequests() {
  const router = useRouter();
  const [requests, setRequests] = useState<
    Tables<"maintenance_requests">[] | null
  >(null);

  const load = useCallback(async () => {
    const data = await cachedSelect<Tables<"maintenance_requests">[]>(
      "tenant:requests",
      supabase
        .from("maintenance_requests")
        .select("*")
        .order("created_at", { ascending: false }),
    );
    setRequests(data ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!requests) return <Loading />;

  return (
    <Screen>
      <View className="flex-row items-center px-5 pb-2 pt-2">
        <Text className="flex-1 text-2xl font-bold text-slate-900">
          My requests
        </Text>
        <Pressable
          onPress={() => router.push("/tenant/new-request")}
          className="flex-row items-center rounded-full bg-brand px-3 py-2"
        >
          <Ionicons name="add" color="#fff" size={18} />
          <Text className="ml-1 font-semibold text-white">New</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        {requests.length === 0 ? (
          <EmptyState
            title="No requests yet"
            subtitle="Report a repair and your landlord sees it straight away."
          />
        ) : (
          requests.map((r) => (
            <Card key={r.id} onPress={() => router.push(`/tenant/request/${r.id}`)}>
              <View className="flex-row items-start justify-between">
                <Text className="flex-1 pr-2 text-base font-semibold text-slate-900">
                  {r.title}
                </Text>
                <Badge label={r.status} />
              </View>
              <View className="mt-2 flex-row items-center">
                <Badge label={r.urgency} />
                <Text className="ml-2 text-xs text-slate-400">
                  {titleCase(r.category)} · {formatDate(r.created_at)}
                </Text>
              </View>
              {r.status === "resolved" && r.rating == null ? (
                <Text className="mt-2 text-xs font-medium text-brand">
                  Tap to rate how it went
                </Text>
              ) : null}
            </Card>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}
