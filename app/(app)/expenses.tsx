import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";

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
import { confirmAction } from "../../lib/confirm";
import type { Tables } from "../../lib/database.types";
import { Constants } from "../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../lib/format";
import { supabase } from "../../lib/supabase";

type Expense = Tables<"expenses"> & {
  properties: { name: string } | null;
};

const CATEGORIES = Constants.public.Enums.expense_category;

export default function Expenses() {
  const router = useRouter();
  const { session } = useAuth();
  const [expenses, setExpenses] = useState<Expense[] | null>(null);
  const [properties, setProperties] = useState<Tables<"properties">[]>([]);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // form
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [category, setCategory] =
    useState<(typeof CATEGORIES)[number]>("repair");
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [description, setDescription] = useState("");

  const load = useCallback(async () => {
    const [e, p] = await Promise.all([
      supabase
        .from("expenses")
        .select("*, properties(name)")
        .order("incurred_on", { ascending: false }),
      supabase.from("properties").select("*").order("name"),
    ]);
    setExpenses((e.data as Expense[]) ?? []);
    setProperties(p.data ?? []);
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
    for (const e of expenses ?? []) {
      if (new Date(e.incurred_on).getFullYear() !== year) continue;
      const cur = e.currency || "USD";
      if (!byCurrency.has(cur))
        byCurrency.set(cur, { total: 0, byCategory: new Map() });
      const bucket = byCurrency.get(cur)!;
      const amt = Number(e.amount) || 0;
      bucket.total += amt;
      bucket.byCategory.set(
        e.category,
        (bucket.byCategory.get(e.category) ?? 0) + amt,
      );
    }
    return byCurrency;
  }, [expenses]);

  function resetForm() {
    setAmount("");
    setCurrency("USD");
    setCategory("repair");
    setPropertyId(null);
    setDescription("");
    setEditingId(null);
  }

  function openAdd() {
    resetForm();
    setAdding(true);
  }

  function openEdit(e: Expense) {
    setAmount(String(e.amount));
    setCurrency(e.currency);
    setCategory(e.category);
    setPropertyId(e.property_id);
    setDescription(e.description ?? "");
    setEditingId(e.id);
    setAdding(true);
  }

  async function save() {
    if (!amount || !session) return;
    setSaving(true);
    const payload = {
      property_id: propertyId,
      amount: Number(amount),
      currency: currency.trim() || "USD",
      category,
      description: description.trim() || null,
    };
    const { error } = editingId
      ? await supabase.from("expenses").update(payload).eq("id", editingId)
      : await supabase
          .from("expenses")
          .insert({ ...payload, owner_id: session.user.id });
    setSaving(false);
    if (!error) {
      setAdding(false);
      resetForm();
      load();
    }
  }

  function remove() {
    if (!editingId) return;
    confirmAction(
      "Delete expense",
      "This permanently removes the expense. This cannot be undone.",
      async () => {
        await supabase.from("expenses").delete().eq("id", editingId);
        setAdding(false);
        resetForm();
        load();
      },
    );
  }

  if (!expenses) return <Loading />;

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
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
          onPress={openAdd}
          className="flex-row items-center rounded-full bg-brand px-3 py-2"
        >
          <Ionicons name="add" color="#fff" size={18} />
          <Text className="ml-1 font-semibold text-white">Add</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        {analytics.size > 0 ? (
          <View className="mb-4">
            <Text className="mb-2 text-sm font-semibold uppercase text-slate-400">
              Spend this year
            </Text>
            {[...analytics.entries()].map(([cur, data]) => (
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
        {expenses.length === 0 ? (
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

      <Modal visible={adding} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[88%] rounded-t-3xl bg-slate-50"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900">
              {editingId ? "Edit expense" : "New expense"}
            </Text>

            <View className="flex-row gap-3">
              <View className="flex-1">
                <Field
                  label="Amount"
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.00"
                  keyboardType="decimal-pad"
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
                  onPress={() => {
                    setPropertyId(propertyId === p.id ? null : p.id);
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

            <Field
              label="Description (optional)"
              value={description}
              onChangeText={setDescription}
              placeholder="What was this for?"
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
                <Button title="Save" onPress={save} loading={saving} />
              </View>
            </View>
            {editingId ? (
              <View className="mt-3">
                <Button title="Delete expense" variant="danger" onPress={remove} />
              </View>
            ) : null}
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
