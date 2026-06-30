import { Ionicons } from "@expo/vector-icons";
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useCallback, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";

import { DocumentsSection } from "../../../components/DocumentsSection";
import {
  Badge,
  Button,
  Card,
  Field,
  Loading,
  Screen,
} from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import type { Tables } from "../../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";

type Unit = Tables<"units"> & {
  properties: { name: string; currency: string } | null;
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between border-b border-slate-100 py-2">
      <Text className="text-slate-500">{label}</Text>
      <Text className="font-medium text-slate-800">{value}</Text>
    </View>
  );
}

export default function UnitDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();

  const [unit, setUnit] = useState<Unit | null>(null);
  const [leases, setLeases] = useState<Tables<"leases">[]>([]);
  const [assets, setAssets] = useState<Tables<"assets">[]>([]);
  const [workOrders, setWorkOrders] = useState<Tables<"work_orders">[]>([]);

  // add-lease modal
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tenantName, setTenantName] = useState("");
  const [tenantPhone, setTenantPhone] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [rent, setRent] = useState("");

  const currency = unit?.properties?.currency ?? unit?.rent_currency ?? "USD";

  const load = useCallback(async () => {
    if (!id) return;
    const [u, l, a, w] = await Promise.all([
      supabase
        .from("units")
        .select("*, properties(name, currency)")
        .eq("id", id)
        .single(),
      supabase
        .from("leases")
        .select("*")
        .eq("unit_id", id)
        .order("start_date", { ascending: false, nullsFirst: false }),
      supabase.from("assets").select("*").eq("unit_id", id),
      supabase
        .from("work_orders")
        .select("*")
        .eq("unit_id", id)
        .in("status", ["open", "in_progress", "on_hold"])
        .order("created_at", { ascending: false }),
    ]);
    setUnit((u.data as Unit) ?? null);
    setLeases(l.data ?? []);
    setAssets(a.data ?? []);
    setWorkOrders(w.data ?? []);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function resetForm() {
    setTenantName("");
    setTenantPhone("");
    setStartDate("");
    setEndDate("");
    setRent("");
  }

  async function saveLease() {
    if (!tenantName.trim() || !session || !id) return;
    setSaving(true);
    await supabase.from("leases").insert({
      owner_id: session.user.id,
      unit_id: id,
      tenant_name: tenantName.trim(),
      tenant_phone: tenantPhone.trim() || null,
      start_date: startDate.trim() || null,
      end_date: endDate.trim() || null,
      rent_amount: rent ? Number(rent) : (unit?.rent_amount ?? null),
      rent_currency: currency,
      status: "active",
    });
    setSaving(false);
    setAdding(false);
    resetForm();
    load();
  }

  if (!unit) return <Loading />;

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/properties")
          }
          className="p-2"
        >
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text
          className="flex-1 text-xl font-bold text-slate-900"
          numberOfLines={1}
        >
          {unit.label}
        </Text>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-12">
        <Card>
          <View className="flex-row items-center justify-between">
            <Badge label={unit.status} />
            <Text className="text-slate-500">
              {unit.properties?.name ?? ""} · {titleCase(unit.unit_type)}
            </Text>
          </View>
        </Card>

        <Card>
          {unit.bedrooms != null ? (
            <Row label="Bedrooms" value={String(unit.bedrooms)} />
          ) : null}
          {unit.bathrooms != null ? (
            <Row label="Bathrooms" value={String(unit.bathrooms)} />
          ) : null}
          {unit.floor ? <Row label="Floor" value={unit.floor} /> : null}
          {unit.size_value != null ? (
            <Row
              label="Size"
              value={`${unit.size_value} ${unit.size_unit ?? ""}`.trim()}
            />
          ) : null}
          {unit.rent_amount != null ? (
            <Row label="Rent" value={formatCurrency(unit.rent_amount, currency)} />
          ) : null}
        </Card>

        {/* Lease / tenant */}
        <View className="mb-2 mt-4 flex-row items-center justify-between">
          <Text className="text-lg font-semibold text-slate-900">
            Lease & tenant
          </Text>
          <Pressable
            onPress={() => setAdding(true)}
            className="flex-row items-center rounded-full bg-brand px-3 py-1.5"
          >
            <Ionicons name="add" color="#fff" size={16} />
            <Text className="ml-1 font-semibold text-white">Add</Text>
          </Pressable>
        </View>
        {leases.length === 0 ? (
          <Text className="mb-2 text-slate-400">No lease on record.</Text>
        ) : (
          leases.map((l) => (
            <Card key={l.id}>
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 pr-2 font-semibold text-slate-900">
                  {l.tenant_name}
                </Text>
                <Badge label={l.status} />
              </View>
              {l.tenant_phone ? (
                <Text className="mt-1 text-slate-500">{l.tenant_phone}</Text>
              ) : null}
              <Text className="mt-1 text-xs text-slate-400">
                {l.start_date ? formatDate(l.start_date) : "—"} →{" "}
                {l.end_date ? formatDate(l.end_date) : "ongoing"}
                {l.rent_amount != null
                  ? ` · ${formatCurrency(l.rent_amount, l.rent_currency ?? currency)}`
                  : ""}
              </Text>
            </Card>
          ))
        )}

        {/* Open work orders */}
        <Text className="mb-2 mt-4 text-lg font-semibold text-slate-900">
          Open work orders ({workOrders.length})
        </Text>
        {workOrders.length === 0 ? (
          <Text className="mb-2 text-slate-400">None open.</Text>
        ) : (
          workOrders.map((w) => (
            <Card key={w.id} onPress={() => router.push(`/work-order/${w.id}`)}>
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 pr-2 text-slate-800">{w.title}</Text>
                <Badge label={w.priority} />
              </View>
            </Card>
          ))
        )}

        {/* Assets */}
        <Text className="mb-2 mt-4 text-lg font-semibold text-slate-900">
          Assets ({assets.length})
        </Text>
        {assets.length === 0 ? (
          <Text className="mb-2 text-slate-400">No assets in this unit.</Text>
        ) : (
          assets.map((a) => (
            <Card key={a.id} onPress={() => router.push(`/asset/${a.id}`)}>
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 pr-2 text-slate-800">{a.name}</Text>
                <Badge label={a.status} />
              </View>
            </Card>
          ))
        )}

        {/* Unit documents */}
        <DocumentsSection
          scope={{ kind: "unit", unitId: unit.id, propertyId: unit.property_id }}
          defaultDocType="lease"
        />
      </ScrollView>

      <Modal visible={adding} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[88%] rounded-t-3xl bg-slate-50"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900">
              New lease
            </Text>
            <Field
              label="Tenant name"
              value={tenantName}
              onChangeText={setTenantName}
              placeholder="Full name"
            />
            <Field
              label="Phone (optional)"
              value={tenantPhone}
              onChangeText={setTenantPhone}
              placeholder="+1-758-…"
              keyboardType="phone-pad"
            />
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Field
                  label="Start (YYYY-MM-DD)"
                  value={startDate}
                  onChangeText={setStartDate}
                  placeholder="2026-07-01"
                  autoCapitalize="none"
                />
              </View>
              <View className="flex-1">
                <Field
                  label="End (optional)"
                  value={endDate}
                  onChangeText={setEndDate}
                  placeholder="2027-06-30"
                  autoCapitalize="none"
                />
              </View>
            </View>
            <Field
              label={`Rent (${currency})`}
              value={rent}
              onChangeText={setRent}
              placeholder={
                unit.rent_amount != null ? String(unit.rent_amount) : "0.00"
              }
              keyboardType="decimal-pad"
            />
            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <Button
                  title="Cancel"
                  variant="secondary"
                  onPress={() => {
                    setAdding(false);
                    resetForm();
                  }}
                />
              </View>
              <View className="flex-1">
                <Button title="Save" onPress={saveLease} loading={saving} />
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
