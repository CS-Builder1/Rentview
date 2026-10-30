import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Loading,
  Screen,
} from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { cachedSelect, cachedSelectResult } from "../../lib/cache";
import { confirmAction } from "../../lib/confirm";
import { useOffline } from "../../lib/offline";
import type { Tables } from "../../lib/database.types";
import { Constants } from "../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../lib/format";
import { supabase } from "../../lib/supabase";
import { localToday } from "../../lib/maintenance";
import { calendarDate, currencyCode, nonNegativeMoney } from "../../lib/validation";
import { operationError, readAllPages } from "../../lib/operationsQuery";
import { newRecordId } from "../../lib/id";
import { totalsByCurrency } from "../../lib/dashboard";

type Expense = Tables<"expenses"> & {
  properties: { name: string } | null;
};

const CATEGORIES = Constants.public.Enums.expense_category;

function notify(title: string, message: string) {
  Platform.OS === "web"
    ? window.alert(`${title}\n\n${message}`)
    : Alert.alert(title, message);
}

export default function Expenses() {
  const router = useRouter();
  const params = useLocalSearchParams<{ propertyId?: string; unitId?: string; workOrderId?: string; new?: string }>();
  const { session } = useAuth();
  const { submitInsert, operations } = useOffline();
  const [expenses, setExpenses] = useState<Expense[] | null>(null);
  const [properties, setProperties] = useState<Tables<"properties">[]>([]);
  const [adding, setAdding] = useState(params.new === "1");
  const [error, setError] = useState<string | null>(null);
  const [incurredOn, setIncurredOn] = useState(localToday());
  const [units, setUnits] = useState<Tables<"units">[]>([]);
  const [vendors, setVendors] = useState<Tables<"vendors">[]>([]);
  const [jobs, setJobs] = useState<Tables<"work_orders">[]>([]);
  const [unitId, setUnitId] = useState<string | null>(params.unitId ?? null);
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [workOrderId, setWorkOrderId] = useState<string | null>(params.workOrderId ?? null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const draft = useRef<{ id: string; accountId: string } | null>(null);
  const savingRef = useRef(false);

  // form
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [category, setCategory] =
    useState<(typeof CATEGORIES)[number]>("repair");
  const [propertyId, setPropertyId] = useState<string | null>(params.propertyId ?? null);
  const [description, setDescription] = useState("");

  const load = useCallback(async () => {
    const all = <T,>(table: "properties" | "units" | "vendors" | "work_orders") => cachedSelect<T[]>(`expense-options:${table}`, readAllPages<T>((from, to) => supabase.from(table).select("*", { count: "exact" }).order("id").range(from, to) as never));
    const [e, p, u, v, w] = await Promise.all([
      cachedSelectResult<Expense[]>("expenses", readAllPages<Expense>((from, to) => supabase.from("expenses").select("*, properties!expenses_property_id_owner_fk(name)", { count: "exact" }).order("incurred_on", { ascending: false }).order("id").range(from, to))),
      all<Tables<"properties">>("properties"), all<Tables<"units">>("units"), all<Tables<"vendors">>("vendors"), all<Tables<"work_orders">>("work_orders"),
    ]);
    setExpenses(e.data ?? []);
    setError(e.error);
    setProperties(p ?? []); setUnits(u ?? []); setVendors(v ?? []); setJobs(w ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Analytics: group by currency (never sum across currencies), this calendar year.
  const analytics = useMemo(() => {
    const year = new Date().getFullYear();
    const byCurrency = new Map<
      string,
      { total: number; byCategory: Map<string, number> }
    >();
    try {
      const rows = (expenses ?? []).filter((expense) => expense.incurred_on.slice(0, 4) === String(year));
      for (const [currency, total] of Object.entries(totalsByCurrency(rows))) {
        byCurrency.set(currency, { total, byCategory: new Map() });
      }
      const categories = new Map<string, Expense[]>();
      for (const expense of rows) {
        const categoryRows = categories.get(expense.category) ?? [];
        categoryRows.push(expense);
        categories.set(expense.category, categoryRows);
      }
      for (const [category, categoryRows] of categories) {
        for (const [currency, total] of Object.entries(totalsByCurrency(categoryRows))) {
          byCurrency.get(currency)!.byCategory.set(category, total);
        }
      }
      return { byCurrency, error: null };
    } catch (cause) {
      // An unrepresentable aggregate must not look like a complete accurate
      // financial summary. Individual receipts remain available for review.
      return { byCurrency: new Map<string, { total: number; byCategory: Map<string, number> }>(), error: operationError(cause) };
    }
  }, [expenses]);

  function resetForm() {
    draft.current = null;
    setAmount("");
    setIncurredOn(localToday());
    setUnitId(params.unitId ?? null); setVendorId(null); setWorkOrderId(params.workOrderId ?? null);
    setCurrency("USD");
    setCategory("repair");
    setPropertyId(params.propertyId ?? null);
    setDescription("");
    setEditingId(null);
  }

  function openAdd() {
    if (savingRef.current) return;
    resetForm();
    setAdding(true);
  }

  function openEdit(e: Expense) {
    if (savingRef.current) return;
    setAmount(String(e.amount));
    setIncurredOn(e.incurred_on); setUnitId(e.unit_id); setVendorId(e.vendor_id); setWorkOrderId(e.work_order_id);
    setCurrency(e.currency);
    setCategory(e.category);
    setPropertyId(e.property_id);
    setDescription(e.description ?? "");
    setEditingId(e.id);
    setAdding(true);
  }

  async function save() {
    if (!amount || !session || savingRef.current) return;
    if (draft.current && draft.current.accountId !== session.user.id) {
      notify("Reopen this expense", "This draft belongs to a different signed-in account. Reopen the expense form before saving.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const payload = {
        property_id: propertyId, unit_id: unitId, vendor_id: vendorId, work_order_id: workOrderId,
        incurred_on: calendarDate(incurredOn, "Expense date")!,
        amount: nonNegativeMoney(amount, "Amount"),
        currency: currencyCode(currency), category, description: description.trim() || null,
      };
      if (editingId) {
        const { error } = await supabase
          .from("expenses")
          .update(payload)
          .eq("id", editingId).select("id").single();
        if (error) throw error;
        setAdding(false);
        resetForm();
        load();
      } else {
        // The form and its durable operation share one identity. A rejected
        // save remains in Saved changes; repeating Save must not fork a second
        // financial operation, including after an ambiguous HTTP response.
        draft.current ??= { id: newRecordId(), accountId: session.user.id };
        if (operations.some((operation) => operation.id === draft.current!.id)) {
          throw new Error("This expense is already saved on this device. Open Saved changes to edit, retry or discard it before creating another expense.");
        }
        const result = await submitInsert("expenses", {
          ...payload,
          id: draft.current.id,
          owner_id: session.user.id,
        });
        setAdding(false);
        resetForm();
        if (result === "queued") {
          notify(
            "Saved offline",
            "This expense will sync automatically when you're back online.",
          );
        } else {
          load();
        }
      }
    } catch (e) {
      notify("Could not save", operationError(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function remove() {
    if (!editingId || savingRef.current) return;
    confirmAction(
      "Delete expense",
      "This permanently removes the expense. This cannot be undone.",
      async () => {
        if (savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        try {
          const { error: deleteError } = await supabase.from("expenses").delete().eq("id", editingId).select("id").single();
          if (deleteError) throw deleteError;
          setAdding(false); resetForm(); await load();
        } catch (cause) { notify("Could not delete", operationError(cause)); }
        finally { savingRef.current = false; setSaving(false); }
      },
    );
  }

  if (!expenses) return <Loading />;

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          disabled={saving}
          accessibilityState={{ disabled: saving }}
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/more")
          }
          className="p-2"
        >
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text className="flex-1 text-xl font-bold text-slate-900">
          Expenses
        </Text>
        <Pressable
          disabled={saving}
          accessibilityState={{ disabled: saving }}
          onPress={openAdd}
          className="flex-row items-center rounded-full bg-brand px-3 py-2"
        >
          <Ionicons name="add" color="#fff" size={18} />
          <Text className="ml-1 font-semibold text-white">Add</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        {error ? <Card><Text accessibilityRole="alert" className="mb-2 text-red-700">{error}</Text><Button title="Retry" onPress={() => void load()} /></Card> : null}
        {analytics.error ? <Card><Text accessibilityRole="alert" className="text-red-700">{analytics.error}</Text></Card> : null}
        {analytics.byCurrency.size > 0 ? (
          <View className="mb-4">
            <Text className="mb-2 text-sm font-semibold uppercase text-slate-400">
              Spend this year
            </Text>
            {[...analytics.byCurrency.entries()].map(([cur, data]) => (
              <Card key={cur}>
                <Text className="text-2xl font-bold text-brand">
                  {formatCurrency(data.total, cur)}
                </Text>
                <View className="mt-3">
                  {[...data.byCategory.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([cat, amt]) => (
                      <View
                        key={cat}
                        className="flex-row items-center justify-between py-1"
                      >
                        <Text className="text-slate-600">{titleCase(cat)}</Text>
                        <Text className="font-medium text-slate-800">
                          {formatCurrency(amt, cur)}
                        </Text>
                      </View>
                    ))}
                </View>
              </Card>
            ))}
          </View>
        ) : null}

        <Text className="mb-2 text-sm font-semibold uppercase text-slate-400">
          Recent
        </Text>
        {expenses.length === 0 && !error ? (
          <EmptyState
            title="No expenses logged"
            subtitle="Track repair, CapEx, utility and supply costs per property to see where money goes."
          />
        ) : (
          expenses.map((e) => (
            <Card key={e.id} onPress={() => openEdit(e)}>
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 pr-2 text-base font-semibold text-slate-900">
                  {e.description || titleCase(e.category)}
                </Text>
                <Text className="font-bold text-slate-800">
                  {formatCurrency(Number(e.amount), e.currency)}
                </Text>
              </View>
              <View className="mt-1 flex-row items-center justify-between">
                <View className="flex-row items-center">
                  <Badge label={e.category} />
                  <Text className="ml-2 text-slate-500">
                    {e.properties?.name ?? "—"}
                  </Text>
                </View>
                <Text className="text-xs text-slate-400">
                  {formatDate(e.incurred_on)}
                </Text>
              </View>
            </Card>
          ))
        )}
      </ScrollView>

      <Modal visible={adding} animationType="slide" transparent onRequestClose={() => { if (!savingRef.current) setAdding(false); }}>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[88%] rounded-t-3xl bg-slate-50"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900">
              {editingId ? "Edit expense" : "New expense"}
            </Text>

            <Field label="Expense date (YYYY-MM-DD)" value={incurredOn} onChangeText={setIncurredOn} autoCapitalize="none" editable={!saving} />
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Field
                  label="Amount"
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.00"
                  keyboardType="decimal-pad"
                  editable={!saving}
                />
              </View>
              <View className="w-28">
                <Field
                  label="Currency"
                  value={currency}
                  onChangeText={(v) => setCurrency(v.toUpperCase())}
                  placeholder="USD"
                  autoCapitalize="characters"
                  maxLength={3}
                  editable={!saving}
                />
              </View>
            </View>

            <Text className="mb-1 text-sm font-medium text-slate-600">
              Category
            </Text>
            <View className="mb-3 flex-row flex-wrap">
              {CATEGORIES.map((c) => (
                <Pressable
                  key={c}
                  disabled={saving}
                  accessibilityState={{ disabled: saving }}
                  onPress={() => setCategory(c)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    category === c
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  <Text
                    className={
                      category === c ? "font-medium text-white" : "text-slate-700"
                    }
                  >
                    {titleCase(c)}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text className="mb-1 text-sm font-medium text-slate-600">
              Property (optional)
            </Text>
            <View className="mb-3 flex-row flex-wrap">
              {properties.map((p) => (
                <Pressable
                  key={p.id}
                  disabled={saving}
                  accessibilityState={{ disabled: saving }}
                  onPress={() => {
                    setPropertyId(propertyId === p.id ? null : p.id);
                    setUnitId(null); setWorkOrderId(null);
                    if (propertyId !== p.id) setCurrency(p.currency);
                  }}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    propertyId === p.id
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  <Text
                    className={
                      propertyId === p.id
                        ? "font-medium text-white"
                        : "text-slate-700"
                    }
                  >
                    {p.name}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text className="mb-1 font-medium text-slate-600">Unit (optional)</Text>
            <View className="mb-3 flex-row flex-wrap"><Button title="Shared / none" disabled={saving} variant={!unitId ? "primary" : "secondary"} onPress={() => { setUnitId(null); setWorkOrderId(null); }} />{units.filter(u => u.property_id === propertyId).map(u => <Button key={u.id} title={u.label} disabled={saving} variant={unitId === u.id ? "primary" : "secondary"} onPress={() => { setUnitId(u.id); setWorkOrderId(null); }} />)}</View>
            <Text className="mb-1 font-medium text-slate-600">Vendor (optional)</Text>
            <View className="mb-3 flex-row flex-wrap"><Button title="No vendor" disabled={saving} variant={!vendorId ? "primary" : "secondary"} onPress={() => setVendorId(null)} />{vendors.map(v => <Button key={v.id} title={v.name} disabled={saving} variant={vendorId === v.id ? "primary" : "secondary"} onPress={() => setVendorId(v.id)} />)}</View>
            <Text className="mb-1 font-medium text-slate-600">Work order (optional)</Text>
            <View className="mb-3 flex-row flex-wrap"><Button title="No job" disabled={saving} variant={!workOrderId ? "primary" : "secondary"} onPress={() => setWorkOrderId(null)} />{jobs.filter(w => w.property_id === propertyId && (!unitId || w.unit_id === unitId) && (w.id === workOrderId || !["completed", "cancelled"].includes(w.status))).map(w => <Button key={w.id} title={w.title} disabled={saving} variant={workOrderId === w.id ? "primary" : "secondary"} onPress={() => { setWorkOrderId(w.id); setUnitId(w.unit_id); setVendorId(w.vendor_id); }} />)}</View>
            {workOrderId && jobs.find(w => w.id === workOrderId)?.completion_expense_id ? <Text className="mb-3 text-amber-800">This expense belongs to a posted job completion. Financial corrections must be made together with that job.</Text> : null}
            <Field
              label="Description (optional)"
              value={description}
              onChangeText={setDescription}
              placeholder="What was this for?"
              editable={!saving}
            />

            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <Button
                  title="Cancel"
                  variant="secondary"
                  disabled={saving}
                  onPress={() => {
                    if (savingRef.current) return;
                    setAdding(false);
                    resetForm();
                  }}
                />
              </View>
              <View className="flex-1">
                <Button title="Save" onPress={save} loading={saving} />
              </View>
            </View>
            {editingId ? (
              <View className="mt-3">
                <Button title="Delete expense" variant="danger" onPress={remove} disabled={saving} />
              </View>
            ) : null}
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
