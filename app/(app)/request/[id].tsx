import { Ionicons } from "@expo/vector-icons";
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { RequestConversation } from "../../../components/RequestConversation";
import { Badge, Button, Card, EmptyState, Loading, Screen } from "../../../components/ui";
import { cachedSelectResult } from "../../../lib/cache";
import type { Tables } from "../../../lib/database.types";
import { Constants } from "../../../lib/database.types";
import { formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";
import { operationError } from "../../../lib/operationsQuery";

type RequestRow = Tables<"maintenance_requests"> & {
  properties: { name: string } | null;
  units: { label: string } | null;
  leases: { tenant_name: string; tenant_phone: string | null } | null;
};

const STATUSES = Constants.public.Enums.request_status;

function notify(title: string, message: string) {
  Platform.OS === "web"
    ? window.alert(`${title}\n\n${message}`)
    : Alert.alert(title, message);
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between border-b border-slate-100 py-2">
      <Text className="text-slate-500">{label}</Text>
      <Text className="flex-1 pl-4 text-right font-medium text-slate-800">
        {value}
      </Text>
    </View>
  );
}

export default function OwnerRequestDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [request, setRequest] = useState<RequestRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const result = await cachedSelectResult<RequestRow>(
      `request:${id}`,
      supabase
        .from("maintenance_requests")
        .select(
          "*, properties!maintenance_requests_property_id_owner_fk(name), units!maintenance_requests_unit_property_owner_fk(label), leases!requests_lease_unit_owner_fk(tenant_name, tenant_phone)",
        )
        .eq("id", id)
        .single(),
    );
    setRequest(result.data);
    setLoadError(result.error);
    setLoaded(true);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function setStatus(status: (typeof STATUSES)[number]) {
    if (!request) return;
    setBusy(true);
    const { error } = await supabase
      .from("maintenance_requests")
      .update({
        status,
        resolved_at:
          status === "resolved" ? new Date().toISOString() : request.resolved_at,
      })
      .eq("id", request.id);
    setBusy(false);
    if (error) {
      notify("Could not update", error.message);
      return;
    }
    load();
  }

  /**
   * Raise the internal work order for this request. Costs, vendors and parts
   * live on the work order, which the tenant never sees; a database trigger
   * mirrors the work order's status back onto the request as it progresses.
   */
  async function convertToWorkOrder() {
    if (!request) return;
    setBusy(true);
    try {
      const { data: workOrderId, error } = await supabase.rpc("convert_request_to_work_order", { p_request_id: request.id });
      if (error) throw error;
      if (!workOrderId) throw new Error("The work order could not be created. Please retry.");

      await load();
      router.push(`/work-order/${workOrderId}`);
    } catch (e) {
      notify("Could not convert", operationError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!request) return loaded ? <Screen><EmptyState title="Request unavailable" subtitle={loadError || "It may have been removed or your access may have changed."} /><Button title="Back to requests" onPress={() => router.replace("/requests")} /><Button title="Retry" variant="secondary" onPress={() => void load()} /></Screen> : <Loading />;

  const locked = request.status === "closed";

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/requests")
          }
          accessibilityLabel="Back to requests"
          className="p-2"
        >
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text className="flex-1 text-xl font-bold text-slate-900" numberOfLines={1}>
          Request
        </Text>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">{loadError ? <View className="mb-3"><Text accessibilityRole="alert" className="mb-2 text-red-700">{loadError}</Text><Button title="Refresh" variant="secondary" onPress={() => void load()} /></View> : null}
        <Card>
          <View className="flex-row items-start justify-between">
            <Text className="flex-1 pr-2 text-xl font-bold text-slate-900">
              {request.title}
            </Text>
            <Badge label={request.status} />
          </View>
          {request.description ? (
            <Text className="mt-2 text-slate-600">{request.description}</Text>
          ) : null}
          <View className="mt-3">
            <Row
              label="Where"
              value={[request.properties?.name, request.units?.label]
                .filter(Boolean)
                .join(" · ")}
            />
            <Row label="Tenant" value={request.leases?.tenant_name ?? "—"} />
            {request.leases?.tenant_phone ? (
              <Row label="Phone" value={request.leases.tenant_phone} />
            ) : null}
            <Row label="Category" value={titleCase(request.category)} />
            <Row label="Urgency" value={titleCase(request.urgency)} />
            <Row label="Reported" value={formatDate(request.created_at)} />
            {request.resolved_at ? (
              <Row label="Resolved" value={formatDate(request.resolved_at)} />
            ) : null}
          </View>
        </Card>

        {request.rating != null ? (
          <Card>
            <Text className="text-sm font-semibold uppercase text-slate-400">
              Tenant rating
            </Text>
            <View className="mt-1 flex-row">
              {[1, 2, 3, 4, 5].map((n) => (
                <Ionicons
                  key={n}
                  name={n <= (request.rating ?? 0) ? "star" : "star-outline"}
                  size={18}
                  color="#f59e0b"
                />
              ))}
            </View>
            {request.rating_comment ? (
              <Text className="mt-2 text-slate-600">{request.rating_comment}</Text>
            ) : null}
          </Card>
        ) : null}

        <Text className="mb-2 mt-4 text-sm font-semibold uppercase text-slate-400">
          Status
        </Text>
        <View className="mb-2 flex-row flex-wrap">
          {STATUSES.map((s) => (
            <Pressable
              key={s}
              onPress={() => setStatus(s)}
              disabled={busy}
              className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                request.status === s
                  ? "border-brand bg-brand"
                  : "border-slate-300 bg-white"
              }`}
            >
              <Text
                className={
                  request.status === s
                    ? "font-medium text-white"
                    : "text-slate-700"
                }
              >
                {titleCase(s)}
              </Text>
            </Pressable>
          ))}
        </View>

        {request.work_order_id ? (
          <Button
            title="Open work order"
            variant="secondary"
            onPress={() => router.push(`/work-order/${request.work_order_id}`)}
          />
        ) : (
          <Button
            title="Convert to work order"
            onPress={convertToWorkOrder}
            loading={busy}
          />
        )}
        <Text className="mt-2 text-xs text-slate-400">
          Costs, vendors and parts stay on the work order — the tenant only
          sees the status and this conversation.
        </Text>

        <RequestConversation requestId={request.id} locked={locked} />
      </ScrollView>
    </Screen>
  );
}
