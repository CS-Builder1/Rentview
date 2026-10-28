import { Ionicons } from "@expo/vector-icons";
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useCallback, useRef, useState } from "react";
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
import { cachedSelectResult } from "../../../lib/cache";
import { confirmAction } from "../../../lib/confirm";
import { useOffline } from "../../../lib/offline";
import type { Tables } from "../../../lib/database.types";
import { Constants } from "../../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";
import { notify } from "../../../lib/feedback";
import { calendarDate, currencyCode, nonNegativeMoney } from "../../../lib/validation";
import { operationError, readAllPages } from "../../../lib/operationsQuery";

const UNIT_TYPES = Constants.public.Enums.unit_type;
const UNIT_STATUSES = Constants.public.Enums.unit_status;
const LEASE_STATUSES = Constants.public.Enums.lease_status;

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
  const generation = useRef(0);
  const { session } = useAuth();
  const { submitInsert } = useOffline();

  const [unit, setUnit] = useState<Unit | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [leases, setLeases] = useState<Tables<"leases">[]>([]);
  const [assets, setAssets] = useState<Tables<"assets">[]>([]);
  const [workOrders, setWorkOrders] = useState<Tables<"work_orders">[]>([]);

  // add-lease modal
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tenantName, setTenantName] = useState("");
  const [tenantPhone, setTenantPhone] = useState("");
  const [tenantEmail, setTenantEmail] = useState("");
  const [deposit, setDeposit] = useState("");
  const [leaseCurrency, setLeaseCurrency] = useState("USD");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [rent, setRent] = useState("");
  const [leaseStatus, setLeaseStatus] =
    useState<(typeof LEASE_STATUSES)[number]>("active");
  const [editingLeaseId, setEditingLeaseId] = useState<string | null>(null);

  // edit-unit modal
  const [editing, setEditing] = useState(false);
  const [eLabel, setELabel] = useState("");
  const [eType, setEType] = useState<(typeof UNIT_TYPES)[number]>("apartment");
  const [eStatus, setEStatus] =
    useState<(typeof UNIT_STATUSES)[number]>("vacant");
  const [eBeds, setEBeds] = useState("");
  const [eBaths, setEBaths] = useState("");
  const [eSize, setESize] = useState("");
  const [eSizeUnit, setESizeUnit] = useState("sqft");
  const [eCurrency, setECurrency] = useState("USD");
  const [eRent, setERent] = useState("");

  const currency = unit?.rent_currency ?? unit?.properties?.currency ?? "USD";

  const load = useCallback(async () => {
    const ticket = ++generation.current;
    if (!id) { setLoadError("Choose a unit to continue."); setLoading(false); return; }
    const [u, l, a, w] = await Promise.all([
      cachedSelectResult<Unit>(`unit:${id}`, supabase.from("units").select("*, properties!units_property_id_owner_fk(name, currency)").eq("id", id).single()),
      cachedSelectResult<Tables<"leases">[]>(`leases:unit:${id}`,
        readAllPages<Tables<"leases">>((from, to) => supabase.from("leases").select("*", { count: "exact" }).eq("unit_id", id).order("start_date", { ascending: false, nullsFirst: false }).order("id").range(from, to))),
      cachedSelectResult<Tables<"assets">[]>(`assets:unit:${id}`,
        readAllPages<Tables<"assets">>((from, to) => supabase.from("assets").select("*", { count: "exact" }).eq("unit_id", id).order("name").order("id").range(from, to))),
      cachedSelectResult<Tables<"work_orders">[]>(`wos:unit:${id}`,
        readAllPages<Tables<"work_orders">>((from, to) => supabase.from("work_orders").select("*", { count: "exact" }).eq("unit_id", id).in("status", ["open", "in_progress", "on_hold"]).order("created_at", { ascending: false }).order("id").range(from, to))),
    ]);
    if (ticket !== generation.current) return;
    setUnit(u.data); setLeases(l.data ?? []); setAssets(a.data ?? []); setWorkOrders(w.data ?? []);
    setLoadError([u.error, l.error, a.error, w.error].filter(Boolean).join(" ") || null);
    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => { generation.current++; };
    }, [load]),
  );

  function resetForm() {
    setTenantName("");
    setTenantPhone("");
    setTenantEmail(""); setDeposit(""); setLeaseCurrency(currency);
    setStartDate("");
    setEndDate("");
    setRent("");
    setLeaseStatus("active");
    setEditingLeaseId(null);
  }

  function openAddLease() {
    resetForm();
    setAdding(true);
  }

  function openEditLease(l: Tables<"leases">) {
    setTenantName(l.tenant_name);
    setTenantPhone(l.tenant_phone ?? "");
    setTenantEmail(l.tenant_email ?? "");
    setDeposit(l.deposit_amount == null ? "" : String(l.deposit_amount));
    setLeaseCurrency(l.rent_currency ?? currency);
    setStartDate(l.start_date ?? "");
    setEndDate(l.end_date ?? "");
    setRent(l.rent_amount != null ? String(l.rent_amount) : "");
    setLeaseStatus(l.status);
    setEditingLeaseId(l.id);
    setAdding(true);
  }

  async function saveLease() {
    if (!tenantName.trim() || !session || !id) { notify("Missing tenant name", "Enter the tenant's name."); return; }
    setSaving(true);
    try {
      const email = tenantEmail.trim().toLowerCase();
      if (email && (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) throw new Error("Enter a valid tenant email address.");
      const start = calendarDate(startDate, "Lease start", true);
      const end = calendarDate(endDate, "Lease end", true);
      if (start && end && end < start) throw new Error("Lease end cannot be before the start date.");
      const payload = {
        tenant_name: tenantName.trim(), tenant_phone: tenantPhone.trim() || null, tenant_email: email || null,
        start_date: start, end_date: end,
        rent_amount: rent.trim() ? nonNegativeMoney(rent, "Rent") : (unit?.rent_amount ?? null),
        rent_currency: currencyCode(leaseCurrency),
        deposit_amount: deposit.trim() ? nonNegativeMoney(deposit, "Deposit") : null,
        status: leaseStatus,
      };
      if (editingLeaseId) {
        const { error } = await supabase.from("leases").update(payload).eq("id", editingLeaseId).select("id").single();
        if (error) throw error;
        setAdding(false); resetForm(); await load();
      } else {
        const result = await submitInsert("leases", { ...payload, owner_id: session.user.id, unit_id: id });
        setAdding(false); resetForm();
        if (result === "queued") notify("Saved on this device", "Review this lease under Sync activity until it uploads.");
        else await load();
      }
    } catch (error) { notify("Could not save lease", operationError(error)); }
    finally { setSaving(false); }
  }

  function removeLease() {
    if (!editingLeaseId) return;
    confirmAction(
      "Delete lease",
      "This permanently removes the lease record. This cannot be undone.",
      async () => {
        try {
          const { error } = await supabase.from("leases").delete().eq("id", editingLeaseId).select("id").single();
          if (error) throw error;
          setAdding(false); resetForm(); await load();
        } catch (error) { notify("Could not delete lease", operationError(error)); }
      },
    );
  }

  function openEdit() {
    if (!unit) return;
    setELabel(unit.label);
    setEType(unit.unit_type);
    setEStatus(unit.status);
    setEBeds(unit.bedrooms != null ? String(unit.bedrooms) : "");
    setEBaths(unit.bathrooms != null ? String(unit.bathrooms) : "");
    setESize(unit.size_value != null ? String(unit.size_value) : "");
    setESizeUnit(unit.size_unit ?? "sqft"); setECurrency(currency);
    setERent(unit.rent_amount != null ? String(unit.rent_amount) : "");
    setEditing(true);
  }

  async function saveEdit() {
    if (!eLabel.trim() || !id) { notify("Missing label", "Enter a unit label."); return; }
    setSaving(true);
    try {
      const beds = eBeds.trim() ? nonNegativeMoney(eBeds, "Bedrooms") : null;
      const baths = eBaths.trim() ? nonNegativeMoney(eBaths, "Bathrooms") : null;
      const size = eSize.trim() ? nonNegativeMoney(eSize, "Size") : null;
      if (beds !== null && (!Number.isSafeInteger(beds) || beds > 32767)) throw new Error("Bedrooms must be a whole number from 0 to 32,767.");
      if (baths !== null && (baths > 99.9 || Math.abs(baths * 10 - Math.round(baths * 10)) > 1e-8)) throw new Error("Bathrooms must be from 0 to 99.9, with at most one decimal place.");
      if (size !== null && size > 99999999.99) throw new Error("The size is outside the supported range.");
      if (!["sqft", "sqm"].includes(eSizeUnit)) throw new Error("Choose square feet or square metres.");
      const { error } = await supabase.from("units").update({
        label: eLabel.trim(), unit_type: eType, status: eStatus, bedrooms: beds, bathrooms: baths,
        size_value: size, size_unit: eSizeUnit,
        rent_amount: eRent.trim() ? nonNegativeMoney(eRent, "Rent") : null,
        rent_currency: currencyCode(eCurrency),
      }).eq("id", id).select("id").single();
      if (error) throw error;
      setEditing(false); await load();
    } catch (error) { notify("Could not update unit", operationError(error)); }
    finally { setSaving(false); }
  }

  function deleteUnit() {
    confirmAction(
      "Delete unit",
      "This permanently deletes the unit and its leases. Assets and work orders are kept but unlinked from it. This cannot be undone.",
      async () => {
        if (!unit) return;
        try {
          const { error } = await supabase.from("units").delete().eq("id", unit.id).select("id").single();
          if (error) throw error;
          router.replace(`/property/${unit.property_id}`);
        } catch (error) { notify("Could not delete unit", operationError(error)); }
      },
    );
  }

  if (loading) return <Loading />;
  if (!unit) return <Screen><View className="p-5"><Text accessibilityRole="alert" className="mb-3 text-red-700">{loadError ?? "This unit is unavailable or you no longer have access."}</Text><Button title="Retry" onPress={() => void load()} /><Button title="Back to properties" variant="secondary" onPress={() => router.replace("/properties")} /></View></Screen>;

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
        <Pressable accessibilityRole="button" accessibilityLabel="Edit unit" onPress={openEdit} className="p-2">
          <Ionicons name="create-outline" size={22} color="#0f766e" />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Delete unit" onPress={deleteUnit} className="p-2">
          <Ionicons name="trash-outline" size={22} color="#dc2626" />
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-12">
        {loadError ? <View className="mb-3"><Text accessibilityRole="alert" className="mb-2 text-red-700">{loadError}</Text><Button title="Retry" variant="secondary" onPress={() => void load()} /></View> : null}
        <View className="mb-3"><Button title="New maintenance job" onPress={() => router.push({ pathname: "/work-orders", params: { new: "1", propertyId: unit.property_id, unitId: unit.id } })} /></View>
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
            onPress={openAddLease}
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
            <Card key={l.id} onPress={() => openEditLease(l)}>
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
              <Pressable
                onPress={event => { event.stopPropagation(); router.push(`/lease/${l.id}`); }}
                className="mt-3 flex-row items-center self-start rounded-full border border-brand px-3 py-1.5"
              >
                <Ionicons
                  name={l.tenant_user_id ? "person-circle-outline" : "key-outline"}
                  size={16}
                  color="#0f766e"
                />
                <Text className="ml-1 text-sm font-medium text-brand">
                  {l.tenant_user_id ? "Portal & rent" : "Invite to portal"}
                </Text>
              </Pressable>
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

      <Modal visible={editing} onRequestClose={() => !saving && setEditing(false)} animationType="slide" transparent>
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
            <Text className="mb-2 font-medium text-slate-600">Area unit</Text>
            <View className="mb-3 flex-row gap-2">{[["sqft", "Square feet"], ["sqm", "Square metres"]].map(([value, label]) => <Button key={value} title={label} variant={eSizeUnit === value ? "primary" : "secondary"} onPress={() => setESizeUnit(value)} />)}</View>
            <Field label="Rent currency" value={eCurrency} onChangeText={setECurrency} autoCapitalize="characters" maxLength={3} />
            <Field
              label={`Rent (${eCurrency})`}
              value={eRent}
              onChangeText={setERent}
              keyboardType="decimal-pad"
            />
            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <Button
                  title="Cancel"
                  disabled={saving}
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

      <Modal visible={adding} onRequestClose={() => !saving && setAdding(false)} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[88%] rounded-t-3xl bg-slate-50"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900">
              {editingLeaseId ? "Edit lease" : "New lease"}
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
            <Field label="Tenant email (optional)" value={tenantEmail} onChangeText={setTenantEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Field
                  label="Start (YYYY-MM-DD, optional)"
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
            <Field label="Lease currency" value={leaseCurrency} onChangeText={setLeaseCurrency} autoCapitalize="characters" maxLength={3} />
            <Field label={`Deposit (${leaseCurrency}, optional)`} value={deposit} onChangeText={setDeposit} keyboardType="decimal-pad" />
            <Field
              label={`Rent (${leaseCurrency})`}
              value={rent}
              onChangeText={setRent}
              placeholder={
                unit.rent_amount != null ? String(unit.rent_amount) : "0.00"
              }
              keyboardType="decimal-pad"
            />
            <Text className="mb-1 text-sm font-medium text-slate-600">Status</Text>
            <View className="mb-3 flex-row flex-wrap">
              {LEASE_STATUSES.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => setLeaseStatus(s)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    leaseStatus === s
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  <Text
                    className={
                      leaseStatus === s ? "font-medium text-white" : "text-slate-700"
                    }
                  >
                    {titleCase(s)}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <Button
                  title="Cancel"
                  disabled={saving}
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
            {editingLeaseId ? (
              <View className="mt-3">
                <Button title="Delete lease" variant="danger" onPress={removeLease} />
              </View>
            ) : null}
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
