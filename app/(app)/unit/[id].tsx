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
import { confirmAction } from "../../../lib/confirm";
import type { Tables } from "../../../lib/database.types";
import { Constants } from "../../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";

const UNIT_TYPES = Constants.public.Enums.unit_type;
const UNIT_STATUSES = Constants.public.Enums.unit_status;

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

  // edit-unit modal
  const [editing, setEditing] = useState(false);
  const [eLabel, setELabel] = useState("");
  const [eType, setEType] = useState<(typeof UNIT_TYPES)[number]>("apartment");
  const [eStatus, setEStatus] =
    useState<(typeof UNIT_STATUSES)[number]>("vacant");
  const [eBeds, setEBeds] = useState("");
  const [eBaths, setEBaths] = useState("");
  const [eSize, setESize] = useState("");
  const [eRent, setERent] = useState("");

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

  function openEdit() {
    if (!unit) return;
    setELabel(unit.label);
    setEType(unit.unit_type);
    setEStatus(unit.status);
    setEBeds(unit.bedrooms != null ? String(unit.bedrooms) : "");
    setEBaths(unit.bathrooms != null ? String(unit.bathrooms) : "");
    setESize(unit.size_value != null ? String(unit.size_value) : "");
    setERent(unit.rent_amount != null ? String(unit.rent_amount) : "");
    setEditing(true);
  }

  async function saveEdit() {
    if (!eLabel.trim() || !id) return;
    setSaving(true);
    const { error } = await supabase
      .from("units")
      .update({
        label: eLabel.trim(),
        unit_type: eType,
        status: eStatus,
        bedrooms: eBeds ? Number(eBeds) : null,
        bathrooms: eBaths ? Number(eBaths) : null,
        size_value: eSize ? Number(eSize) : null,
        rent_amount: eRent ? Number(eRent) : null,
        rent_currency: currency,
      })
      .eq("id", id);
    setSaving(false);
    if (!error) {
      setEditing(false);
      load();
    }
  }

  function deleteUnit() {
    confirmAction(
      "Delete unit",
      "This permanently deletes the unit and its leases. Assets and work orders are kept but unlinked from it. This cannot be undone.",
      async () => {
        if (!unit) return;
        await supabase.from("units").delete().eq("id", unit.id);
        router.replace(`/property/${unit.property_id}`);
      },
    );
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
        <Pressable onPress={openEdit} className="p-2">
          <Ionicons name="create-outline" size={22} color="#0f766e" />
        </Pressable>
        <Pressable onPress={deleteUnit} className="p-2">
          <Ionicons name="trash-outline" size={22} color="#dc2626" />
        </Pressable>
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

      <Modal visible={editing} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[88%] rounded-t-3xl bg-slate-50"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900">Edit unit</Text>
            <Field label="Label" value={eLabel} onChangeText={setELabel} />
            <Text className="mb-1 text-sm font-medium text-slate-600">Type</Text>
            <View className="mb-3 flex-row flex-wrap">
              {UNIT_TYPES.map((t) => (
                <Pressable
                  key={t}
                  onPress={() => setEType(t)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    eType === t ? "border-brand bg-brand" : "border-slate-300 bg-white"
                  }`}
                >
                  <Text className={eType === t ? "font-medium text-white" : "text-slate-700"}>
                    {titleCase(t)}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text className="mb-1 text-sm font-medium text-slate-600">Status</Text>
            <View className="mb-3 flex-row flex-wrap">
              {UNIT_STATUSES.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => setEStatus(s)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    eStatus === s ? "border-brand bg-brand" : "border-slate-300 bg-white"
                  }`}
                >
                  <Text className={eStatus === s ? "font-medium text-white" : "text-slate-700"}>
                    {titleCase(s)}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Field
                  label="Bedrooms"
                  value={eBeds}
                  onChangeText={setEBeds}
                  keyboardType="number-pad"
                />
              </View>
              <View className="flex-1">
                <Field
                  label="Bathrooms"
                  value={eBaths}
                  onChangeText={setEBaths}
                  keyboardType="decimal-pad"
                />
              </View>
            </View>
            <Field
              label="Size"
              value={eSize}
              onChangeText={setESize}
              keyboardType="decimal-pad"
            />
            <Field
              label={`Rent (${currency})`}
              value={eRent}
              onChangeText={setERent}
              keyboardType="decimal-pad"
            />
            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <Button
                  title="Cancel"
                  variant="secondary"
                  onPress={() => setEditing(false)}
                />
              </View>
              <View className="flex-1">
                <Button title="Save" onPress={saveEdit} loading={saving} />
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>

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
