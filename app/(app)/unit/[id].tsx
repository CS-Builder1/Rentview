import { Ionicons } from "@expo/vector-icons";
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, Share, Text, View } from "react-native";

import { DocumentsSection } from "../../../components/DocumentsSection";
import {
  Badge,
  Button,
  Card,
  Field,
  Loading,
  Screen,
  Icon,
} from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import { cachedSelect } from "../../../lib/cache";
import { confirmAction } from "../../../lib/confirm";
import { generateInviteCode } from "../../../lib/invites";
import { useOffline } from "../../../lib/offline";
import type { Tables } from "../../../lib/database.types";
import { Constants } from "../../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";

function notify(title: string, message: string) {
  Platform.OS === "web"
    ? window.alert(`${title}\n\n${message}`)
    : Alert.alert(title, message);
}

const UNIT_TYPES = Constants.public.Enums.unit_type;
const UNIT_STATUSES = Constants.public.Enums.unit_status;
const LEASE_STATUSES = Constants.public.Enums.lease_status;
const PAYMENT_METHODS = Constants.public.Enums.payment_method;

type Unit = Tables<"units"> & {
  properties: { name: string; currency: string } | null;
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between border-b border-slate-100 dark:border-slate-800 py-2">
      <Text className="text-slate-500 dark:text-slate-400">{label}</Text>
      <Text className="font-medium text-slate-800 dark:text-slate-200">{value}</Text>
    </View>
  );
}

export default function UnitDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const { submitInsert } = useOffline();

  const [unit, setUnit] = useState<Unit | null>(null);
  const [leases, setLeases] = useState<Tables<"leases">[]>([]);
  const [assets, setAssets] = useState<Tables<"assets">[]>([]);
  const [workOrders, setWorkOrders] = useState<Tables<"work_orders">[]>([]);
  const [payments, setPayments] = useState<Tables<"rent_payments">[]>([]);
  const [invitingLeaseId, setInvitingLeaseId] = useState<string | null>(null);

  // record-payment modal
  const [payingLease, setPayingLease] = useState<Tables<"leases"> | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payDueDate, setPayDueDate] = useState("");
  const [payPaidOn, setPayPaidOn] = useState("");
  const [payMethod, setPayMethod] =
    useState<(typeof PAYMENT_METHODS)[number]>("bank_transfer");
  const [payNote, setPayNote] = useState("");
  const [savingPayment, setSavingPayment] = useState(false);

  // add-lease modal
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tenantName, setTenantName] = useState("");
  const [tenantPhone, setTenantPhone] = useState("");
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
  const [eRent, setERent] = useState("");

  const currency = unit?.properties?.currency ?? unit?.rent_currency ?? "USD";

  const load = useCallback(async () => {
    if (!id) return;
    const [u, l, a, w] = await Promise.all([
      cachedSelect<Unit>(
        `unit:${id}`,
        supabase
          .from("units")
          .select("*, properties(name, currency)")
          .eq("id", id)
          .single(),
      ),
      cachedSelect<Tables<"leases">[]>(
        `leases:unit:${id}`,
        supabase
          .from("leases")
          .select("*")
          .eq("unit_id", id)
          .order("start_date", { ascending: false, nullsFirst: false }),
      ),
      cachedSelect<Tables<"assets">[]>(
        `assets:unit:${id}`,
        supabase.from("assets").select("*").eq("unit_id", id),
      ),
      cachedSelect<Tables<"work_orders">[]>(
        `wos:unit:${id}`,
        supabase
          .from("work_orders")
          .select("*")
          .eq("unit_id", id)
          .in("status", ["open", "in_progress", "on_hold"])
          .order("created_at", { ascending: false }),
      ),
    ]);
    setUnit(u ?? null);
    setLeases(l ?? []);
    setAssets(a ?? []);
    setWorkOrders(w ?? []);
    const leaseIds = (l ?? []).map((lease) => lease.id);
    if (leaseIds.length > 0) {
      const pays = await cachedSelect<Tables<"rent_payments">[]>(
        `payments:unit:${id}`,
        supabase
          .from("rent_payments")
          .select("*")
          .in("lease_id", leaseIds)
          .order("due_date", { ascending: false, nullsFirst: false })
          .limit(12),
      );
      setPayments(pays ?? []);
    } else {
      setPayments([]);
    }
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
    setStartDate(l.start_date ?? "");
    setEndDate(l.end_date ?? "");
    setRent(l.rent_amount != null ? String(l.rent_amount) : "");
    setLeaseStatus(l.status);
    setEditingLeaseId(l.id);
    setAdding(true);
  }

  async function saveLease() {
    if (!tenantName.trim() || !session || !id) return;
    setSaving(true);
    const payload = {
      tenant_name: tenantName.trim(),
      tenant_phone: tenantPhone.trim() || null,
      start_date: startDate.trim() || null,
      end_date: endDate.trim() || null,
      rent_amount: rent ? Number(rent) : (unit?.rent_amount ?? null),
      rent_currency: currency,
      status: leaseStatus,
    };
    try {
      if (editingLeaseId) {
        const { error } = await supabase
          .from("leases")
          .update(payload)
          .eq("id", editingLeaseId);
        if (error) throw error;
        setAdding(false);
        resetForm();
        load();
      } else {
        const result = await submitInsert("leases", {
          ...payload,
          owner_id: session.user.id,
          unit_id: id,
        });
        setAdding(false);
        resetForm();
        if (result === "queued") {
          notify(
            "Saved offline",
            "This lease will sync automatically when you're back online.",
          );
        } else {
          load();
        }
      }
    } catch (e) {
      notify("Could not save", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function removeLease() {
    if (!editingLeaseId) return;
    confirmAction(
      "Delete lease",
      "This permanently removes the lease record. This cannot be undone.",
      async () => {
        await supabase.from("leases").delete().eq("id", editingLeaseId);
        setAdding(false);
        resetForm();
        load();
      },
    );
  }

  async function inviteTenant(l: Tables<"leases">) {
    if (!session) return;
    setInvitingLeaseId(l.id);
    try {
      const code = generateInviteCode();
      const { error } = await supabase.from("tenant_invites").insert({
        owner_id: session.user.id,
        lease_id: l.id,
        code,
        email: l.tenant_email,
      });
      if (error) throw error;
      const appUrl = process.env.EXPO_PUBLIC_APP_URL;
      const link = appUrl ? `${appUrl}/login?code=${code}` : null;
      const message =
        `Hi ${l.tenant_name.split(" ")[0]}! Join me on RentView to report repairs and see your rent info.\n\n` +
        `Your invite code: ${code}\n` +
        (link ? `Sign up here: ${link}\n` : "") +
        `The code expires in 14 days.`;
      if (Platform.OS === "web") {
        if (navigator.share) {
          await navigator.share({ message, text: message } as ShareData);
        } else {
          await navigator.clipboard?.writeText(message);
          notify("Invite created", `Code ${code} copied to clipboard — send it to ${l.tenant_name}.`);
        }
      } else {
        await Share.share({ message });
      }
    } catch (e) {
      notify("Could not create invite", e instanceof Error ? e.message : String(e));
    } finally {
      setInvitingLeaseId(null);
    }
  }

  function openRecordPayment(l: Tables<"leases">) {
    setPayingLease(l);
    setPayAmount(l.rent_amount != null ? String(l.rent_amount) : "");
    setPayDueDate(new Date().toISOString().slice(0, 10));
    setPayPaidOn(new Date().toISOString().slice(0, 10));
    setPayMethod("bank_transfer");
    setPayNote("");
  }

  async function savePayment() {
    if (!payingLease || !session || !payAmount) return;
    setSavingPayment(true);
    try {
      const { error } = await supabase.from("rent_payments").insert({
        owner_id: session.user.id,
        lease_id: payingLease.id,
        amount: Number(payAmount),
        currency: payingLease.rent_currency ?? currency,
        due_date: payDueDate.trim() || null,
        paid_on: payPaidOn.trim() || null,
        method: payMethod,
        note: payNote.trim() || null,
      });
      if (error) throw error;
      setPayingLease(null);
      load();
    } catch (e) {
      notify("Could not record payment", e instanceof Error ? e.message : String(e));
    } finally {
      setSavingPayment(false);
    }
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
          <Icon name="chevron-back" size={24} />
        </Pressable>
        <Text
          className="flex-1 text-xl font-bold text-slate-900 dark:text-slate-100"
          numberOfLines={1}
        >
          {unit.label}
        </Text>
        <Pressable onPress={openEdit} className="p-2">
          <Icon name="create-outline" size={22} />
        </Pressable>
        <Pressable onPress={deleteUnit} className="p-2">
          <Icon name="trash-outline" size={22} tone="danger" />
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-12">
        <Card>
          <View className="flex-row items-center justify-between">
            <Badge label={unit.status} />
            <Text className="text-slate-500 dark:text-slate-400">
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
          <Text className="text-lg font-semibold text-slate-900 dark:text-slate-100">
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
          <Text className="mb-2 text-slate-400 dark:text-slate-500">No lease on record.</Text>
        ) : (
          leases.map((l) => (
            <Card key={l.id} onPress={() => openEditLease(l)}>
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 pr-2 font-semibold text-slate-900 dark:text-slate-100">
                  {l.tenant_name}
                </Text>
                <Badge label={l.status} />
              </View>
              {l.tenant_phone ? (
                <Text className="mt-1 text-slate-500 dark:text-slate-400">{l.tenant_phone}</Text>
              ) : null}
              <Text className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                {l.start_date ? formatDate(l.start_date) : "—"} →{" "}
                {l.end_date ? formatDate(l.end_date) : "ongoing"}
                {l.rent_amount != null
                  ? ` · ${formatCurrency(l.rent_amount, l.rent_currency ?? currency)}`
                  : ""}
              </Text>
              <View className="mt-3 flex-row items-center border-t border-slate-100 pt-3 dark:border-slate-800">
                {l.tenant_user_id ? (
                  <View className="mr-2 flex-row items-center rounded-full bg-brand-50 px-2.5 py-1.5 dark:bg-brand-950">
                    <Icon name="link" size={13} />
                    <Text className="ml-1 text-xs font-medium text-brand-800 dark:text-brand-300">
                      Tenant app linked
                    </Text>
                  </View>
                ) : (
                  <Pressable
                    onPress={() => inviteTenant(l)}
                    disabled={invitingLeaseId === l.id}
                    className="mr-2 flex-row items-center rounded-full border border-brand px-2.5 py-1.5"
                  >
                    <Icon name="paper-plane-outline" size={13} />
                    <Text className="ml-1 text-xs font-medium text-brand dark:text-brand-400">
                      {invitingLeaseId === l.id ? "Creating…" : "Invite to app"}
                    </Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => openRecordPayment(l)}
                  className="flex-row items-center rounded-full border border-slate-300 px-2.5 py-1.5 dark:border-slate-700"
                >
                  <Icon name="cash-outline" size={13} tone="muted" />
                  <Text className="ml-1 text-xs font-medium text-slate-600 dark:text-slate-300">
                    Record payment
                  </Text>
                </Pressable>
              </View>
            </Card>
          ))
        )}

        {/* Rent payments */}
        {payments.length > 0 ? (
          <>
            <Text className="mb-2 mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
              Rent payments
            </Text>
            <Card>
              {payments.map((p, idx) => (
                <View
                  key={p.id}
                  className={`flex-row items-center justify-between py-2 ${
                    idx < payments.length - 1
                      ? "border-b border-slate-100 dark:border-slate-800"
                      : ""
                  }`}
                >
                  <View>
                    <Text className="font-medium text-slate-900 dark:text-slate-100">
                      {formatCurrency(p.amount, p.currency)}
                    </Text>
                    <Text className="text-xs text-slate-400 dark:text-slate-500">
                      {p.due_date ? `Due ${formatDate(p.due_date)}` : ""}
                      {p.method ? ` · ${titleCase(p.method)}` : ""}
                    </Text>
                  </View>
                  {p.paid_on ? (
                    <View className="flex-row items-center">
                      <Icon name="checkmark-circle" size={16} tone="success" />
                      <Text className="ml-1 text-sm text-slate-600 dark:text-slate-300">
                        {formatDate(p.paid_on)}
                      </Text>
                    </View>
                  ) : (
                    <View className="flex-row items-center">
                      <Icon name="time" size={16} tone="warning" />
                      <Text className="ml-1 text-sm text-slate-600 dark:text-slate-300">
                        Unpaid
                      </Text>
                    </View>
                  )}
                </View>
              ))}
            </Card>
          </>
        ) : null}

        {/* Open work orders */}
        <Text className="mb-2 mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
          Open work orders ({workOrders.length})
        </Text>
        {workOrders.length === 0 ? (
          <Text className="mb-2 text-slate-400 dark:text-slate-500">None open.</Text>
        ) : (
          workOrders.map((w) => (
            <Card key={w.id} onPress={() => router.push(`/work-order/${w.id}`)}>
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 pr-2 text-slate-800 dark:text-slate-200">{w.title}</Text>
                <Badge label={w.priority} />
              </View>
            </Card>
          ))
        )}

        {/* Assets */}
        <Text className="mb-2 mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
          Assets ({assets.length})
        </Text>
        {assets.length === 0 ? (
          <Text className="mb-2 text-slate-400 dark:text-slate-500">No assets in this unit.</Text>
        ) : (
          assets.map((a) => (
            <Card key={a.id} onPress={() => router.push(`/asset/${a.id}`)}>
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 pr-2 text-slate-800 dark:text-slate-200">{a.name}</Text>
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
            className="max-h-[88%] rounded-t-3xl bg-slate-50 dark:bg-slate-900"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900 dark:text-slate-100">Edit unit</Text>
            <Field label="Label" value={eLabel} onChangeText={setELabel} />
            <Text className="mb-1 text-sm font-medium text-slate-600 dark:text-slate-300">Type</Text>
            <View className="mb-3 flex-row flex-wrap">
              {UNIT_TYPES.map((t) => (
                <Pressable
                  key={t}
                  onPress={() => setEType(t)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    eType === t ? "border-brand bg-brand" : "border-slate-300 dark:border-slate-700 bg-white dark:bg-surface-dark"
                  }`}
                >
                  <Text className={eType === t ? "font-medium text-white" : "text-slate-700 dark:text-slate-200"}>
                    {titleCase(t)}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text className="mb-1 text-sm font-medium text-slate-600 dark:text-slate-300">Status</Text>
            <View className="mb-3 flex-row flex-wrap">
              {UNIT_STATUSES.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => setEStatus(s)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    eStatus === s ? "border-brand bg-brand" : "border-slate-300 dark:border-slate-700 bg-white dark:bg-surface-dark"
                  }`}
                >
                  <Text className={eStatus === s ? "font-medium text-white" : "text-slate-700 dark:text-slate-200"}>
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
            className="max-h-[88%] rounded-t-3xl bg-slate-50 dark:bg-slate-900"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900 dark:text-slate-100">
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
            <Text className="mb-1 text-sm font-medium text-slate-600 dark:text-slate-300">Status</Text>
            <View className="mb-3 flex-row flex-wrap">
              {LEASE_STATUSES.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => setLeaseStatus(s)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    leaseStatus === s
                      ? "border-brand bg-brand"
                      : "border-slate-300 dark:border-slate-700 bg-white dark:bg-surface-dark"
                  }`}
                >
                  <Text
                    className={
                      leaseStatus === s ? "font-medium text-white" : "text-slate-700 dark:text-slate-200"
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

      <Modal visible={payingLease !== null} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[88%] rounded-t-3xl bg-slate-50 dark:bg-slate-900"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900 dark:text-slate-100">
              Record rent payment
            </Text>
            <Text className="mb-3 text-slate-500 dark:text-slate-400">
              {payingLease?.tenant_name} · {unit.label}
            </Text>
            <Field
              label={`Amount (${payingLease?.rent_currency ?? currency})`}
              value={payAmount}
              onChangeText={setPayAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
            />
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Field
                  label="Due (YYYY-MM-DD)"
                  value={payDueDate}
                  onChangeText={setPayDueDate}
                  autoCapitalize="none"
                />
              </View>
              <View className="flex-1">
                <Field
                  label="Paid on (blank = unpaid)"
                  value={payPaidOn}
                  onChangeText={setPayPaidOn}
                  autoCapitalize="none"
                />
              </View>
            </View>
            <Text className="mb-1 text-sm font-medium text-slate-600 dark:text-slate-300">
              Method
            </Text>
            <View className="mb-3 flex-row flex-wrap">
              {PAYMENT_METHODS.map((m) => (
                <Pressable
                  key={m}
                  onPress={() => setPayMethod(m)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    payMethod === m
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white dark:border-slate-700 dark:bg-surface-dark"
                  }`}
                >
                  <Text
                    className={
                      payMethod === m
                        ? "font-medium text-white"
                        : "text-slate-700 dark:text-slate-200"
                    }
                  >
                    {titleCase(m)}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Field
              label="Note (optional)"
              value={payNote}
              onChangeText={setPayNote}
              placeholder="Reference, partial payment…"
            />
            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <Button
                  title="Cancel"
                  variant="secondary"
                  onPress={() => setPayingLease(null)}
                />
              </View>
              <View className="flex-1">
                <Button title="Save" onPress={savePayment} loading={savingPayment} />
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
