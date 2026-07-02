import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";

import {
  RequestPhotos,
  RequestThread,
  StatusTimeline,
} from "../../../components/RequestShared";
import { useToast } from "../../../components/Toast";
import { Badge, Button, Card, Icon, Loading, Screen } from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import { cachedSelect } from "../../../lib/cache";
import type { Tables } from "../../../lib/database.types";
import { formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";

type Request = Tables<"maintenance_requests"> & {
  properties: { name: string } | null;
  units: { label: string } | null;
  leases: { tenant_name: string } | null;
};

export default function OwnerRequestDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const toast = useToast();
  const [request, setRequest] = useState<Request | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const rows = await cachedSelect<Request[]>(
      `owner.request.${id}`,
      supabase
        .from("maintenance_requests")
        .select("*, properties(name), units(label), leases(tenant_name)")
        .eq("id", id),
    );
    setRequest(rows?.[0] ?? null);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshKey((k) => k + 1);
    setRefreshing(false);
  }, [load]);

  async function setStatus(status: Tables<"maintenance_requests">["status"]) {
    if (!request) return;
    setWorking(true);
    try {
      const { error } = await supabase
        .from("maintenance_requests")
        .update({
          status,
          resolved_at: status === "resolved" ? new Date().toISOString() : request.resolved_at,
        })
        .eq("id", request.id);
      if (error) throw error;
      toast.show(status === "resolved" ? "Marked resolved" : `Status: ${titleCase(status)}`);
      load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Could not update", "error");
    } finally {
      setWorking(false);
    }
  }

  async function convertToWorkOrder() {
    if (!request || !session) return;
    setWorking(true);
    try {
      const { data, error } = await supabase
        .from("work_orders")
        .insert({
          owner_id: session.user.id,
          property_id: request.property_id,
          unit_id: request.unit_id,
          title: request.title,
          description: [
            request.description,
            `— Reported by ${request.leases?.tenant_name ?? "tenant"} via the tenant portal.`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          priority: request.urgency,
          status: "open",
        })
        .select("id")
        .single();
      if (error) throw error;
      const { error: linkErr } = await supabase
        .from("maintenance_requests")
        .update({ work_order_id: data.id, status: "acknowledged" })
        .eq("id", request.id);
      if (linkErr) throw linkErr;
      toast.show("Work order created and linked");
      router.push(`/work-order/${data.id}`);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Could not convert", "error");
    } finally {
      setWorking(false);
    }
  }

  if (!request) return <Loading />;

  const tenantName = request.leases?.tenant_name ?? "Tenant";
  const isOpen = !["resolved", "closed"].includes(request.status);

  return (
    <Screen>
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable onPress={() => router.back()} className="p-1 pr-3">
          <Icon name="chevron-back" size={24} />
        </Pressable>
        <Text
          className="flex-1 text-xl font-bold text-slate-900 dark:text-slate-100"
          numberOfLines={1}
        >
          {request.title}
        </Text>
        <Badge label={request.status} />
      </View>

      <ScrollView
        contentContainerClassName="px-5 pb-10"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <Card>
          <Text className="text-slate-500 dark:text-slate-400">
            {tenantName} · {request.properties?.name ?? "—"}
            {request.units?.label ? ` · ${request.units.label}` : ""}
          </Text>
          <View className="mt-2 flex-row items-center justify-between">
            <Badge label={request.urgency} />
            <Text className="text-xs text-slate-400 dark:text-slate-500">
              {titleCase(request.category)} · {formatDate(request.created_at)}
            </Text>
          </View>
          {request.description ? (
            <Text className="mt-2 text-slate-600 dark:text-slate-300">
              {request.description}
            </Text>
          ) : null}
          {request.rating ? (
            <View className="mt-3 flex-row items-center border-t border-slate-100 pt-2 dark:border-slate-800">
              {[1, 2, 3, 4, 5].map((s) => (
                <Ionicons
                  key={s}
                  name={request.rating! >= s ? "star" : "star-outline"}
                  size={16}
                  color="#f59e0b"
                />
              ))}
              {request.rating_comment ? (
                <Text className="ml-2 flex-1 text-sm text-slate-500 dark:text-slate-400">
                  “{request.rating_comment}”
                </Text>
              ) : null}
            </View>
          ) : null}
        </Card>

        <RequestPhotos requestId={request.id} />

        {isOpen ? (
          <Card>
            <Text className="mb-2 text-sm font-semibold uppercase text-slate-400 dark:text-slate-500">
              Actions
            </Text>
            <View className="gap-2">
              {request.status === "submitted" ? (
                <Button
                  title="Acknowledge"
                  variant="secondary"
                  onPress={() => setStatus("acknowledged")}
                  loading={working}
                />
              ) : null}
              {!request.work_order_id ? (
                <Button
                  title="Convert to work order"
                  onPress={convertToWorkOrder}
                  loading={working}
                />
              ) : (
                <Button
                  title="View linked work order"
                  variant="secondary"
                  onPress={() => router.push(`/work-order/${request.work_order_id}`)}
                />
              )}
              <Button
                title="Mark resolved"
                variant="ghost"
                onPress={() => setStatus("resolved")}
                loading={working}
              />
            </View>
          </Card>
        ) : request.work_order_id ? (
          <Card>
            <Button
              title="View linked work order"
              variant="secondary"
              onPress={() => router.push(`/work-order/${request.work_order_id}`)}
            />
          </Card>
        ) : null}

        <StatusTimeline status={request.status} />

        {session ? (
          <RequestThread
            requestId={request.id}
            currentUserId={session.user.id}
            senderName={(session.user.user_metadata?.full_name as string) ?? "You"}
            counterpartName={tenantName}
            refreshKey={refreshKey}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}
