import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";

import {
  Button,
  Card,
  EmptyState,
  Field,
  Loading,
  Screen,
} from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { cachedSelectResult } from "../../lib/cache";
import { confirmAction } from "../../lib/confirm";
import type { Tables } from "../../lib/database.types";
import { formatCurrency } from "../../lib/format";
import { supabase } from "../../lib/supabase";
import { operationError, readAllPages } from "../../lib/operationsQuery";
import { notify } from "../../lib/feedback";
import { positiveNumber } from "../../lib/maintenance";

type Item = Tables<"inventory_items"> & {
  properties: { name: string; currency: string } | null;
};

function isLow(item: Item): boolean {
  return (
    item.low_stock_threshold != null &&
    Number(item.quantity) <= Number(item.low_stock_threshold)
  );
}

export default function Inventory() {
  const router = useRouter();
  const params = useLocalSearchParams<{ filter?: string }>();
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [costCurrency, setCostCurrency] = useState("USD");
  const { session } = useAuth();
  const [items, setItems] = useState<Item[] | null>(null);
  const [properties, setProperties] = useState<Tables<"properties">[]>([]);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // form
  const [name, setName] = useState("");
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("");
  const [threshold, setThreshold] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [location, setLocation] = useState("");

  const load = useCallback(async () => {
    const [i, p] = await Promise.all([
      cachedSelectResult<Item[]>(
        "inventory",
        readAllPages<Item>((from, to) => supabase
          .from("inventory_items")
          .select("*, properties!inventory_items_property_id_owner_fk(name, currency)", { count: "exact" })
          .order("name").order("id").range(from, to)),
      ),
      cachedSelectResult<Tables<"properties">[]>(
        "properties_min",
        supabase.from("properties").select("*").order("name"),
      ),
    ]);
    setItems(i.data ?? []);
    setProperties(p.data ?? []);
    setError(i.error || p.error);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function resetForm() {
    setName("");
    setPropertyId(null);
    setQuantity("");
    setThreshold("");
    setUnitCost("");
    setLocation("");
    setEditingId(null);
    setCostCurrency("USD");
  }

  function openAdd() {
    resetForm();
    setAdding(true);
  }

  function openEdit(it: Item) {
    setName(it.name);
    setPropertyId(it.property_id);
    setQuantity(String(it.quantity));
    setThreshold(it.low_stock_threshold != null ? String(it.low_stock_threshold) : "");
    setUnitCost(it.unit_cost != null ? String(it.unit_cost) : "");
    setLocation(it.location ?? "");
    setEditingId(it.id);
    setCostCurrency(it.cost_currency || it.properties?.currency || "USD");
    setAdding(true);
  }

  async function save() {
    if (!session || saving) return;
    try {
      if (!name.trim()) throw new Error("Enter an item name.");
      const qty = positiveNumber(quantity || "0", "Quantity", true);
      const limit = threshold.trim() ? positiveNumber(threshold, "Low-stock threshold", true) : null;
      const cost = unitCost.trim() ? positiveNumber(unitCost, "Unit cost", true) : null;
      if (!/^[A-Z]{3}$/.test(costCurrency.trim())) throw new Error("Enter a three-letter currency code such as XCD or USD.");
      setSaving(true);
      const payload = { property_id: propertyId, name: name.trim(), quantity: qty, low_stock_threshold: limit, unit_cost: cost, cost_currency: costCurrency.trim(), location: location.trim() || null };
      const { error: e } = editingId ? await supabase.from("inventory_items").update(payload).eq("id", editingId).select("id").single() : await supabase.from("inventory_items").insert({ ...payload, owner_id: session.user.id }).select("id").single();
      if (e) throw e;
      setAdding(false); resetForm(); await load();
    } catch (e) { notify("Could not save item", operationError(e)); }
    finally { setSaving(false); }
  }

  function remove() {
    if (!editingId) return;
    confirmAction(
      "Delete item",
      "This permanently removes the inventory item. This cannot be undone.",
      async () => {
        const { error: e } = await supabase.from("inventory_items").delete().eq("id", editingId).select("id").single();
        if (e) { notify("Could not delete item", e.message); return; }
        setAdding(false);
        resetForm();
        load();
      },
    );
  }

  if (!items) return <Loading />;

  const lowCount = items.filter(isLow).length;
  const visible = items.filter(i => (params.filter !== "low" || isLow(i)) && `${i.name} ${i.properties?.name ?? ""} ${i.location ?? ""}`.toLowerCase().includes(search.toLowerCase()));

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
          Inventory & parts
        </Text>
        <Pressable
          onPress={openAdd}
          className="flex-row items-center rounded-full bg-brand px-3 py-2"
        >
          <Ionicons name="add" color="#fff" size={18} />
          <Text className="ml-1 font-semibold text-white">Add</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10"><Field label="Search inventory" value={search} onChangeText={setSearch} placeholder="Name, property or storage location" />{error ? <><Text accessibilityRole="alert" className="mb-2 text-red-700">{error}</Text><Button title="Retry" variant="secondary" onPress={() => void load()} /></> : null}{params.filter === "low" ? <View className="mb-3"><Button title="Show all inventory" variant="secondary" onPress={() => router.setParams({ filter: "all" })} /></View> : null}
        {lowCount > 0 ? (
          <View className="mb-3 rounded-xl bg-amber-100 px-4 py-3">
            <Text className="font-medium text-amber-800">
              {lowCount} item{lowCount === 1 ? "" : "s"} at or below low-stock level.
            </Text>
          </View>
        ) : null}

        {visible.length === 0 && !error ? (
          <EmptyState
            title="No supplies tracked"
            subtitle="Log parts and supplies on hand, set low-stock alerts, and link consumption to work orders."
          />
        ) : (
          visible.map((it) => (
            <Card key={it.id} onPress={() => openEdit(it)}>
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 pr-2 text-base font-semibold text-slate-900">
                  {it.name}
                </Text>
                <Text
                  className={`text-base font-bold ${
                    isLow(it) ? "text-amber-600" : "text-slate-700"
                  }`}
                >
                  {Number(it.quantity)} {it.unit_label ?? ""}
                </Text>
              </View>
              <Text className="mt-1 text-slate-500">
                {it.properties?.name ?? "Global stock"}
                {it.location ? ` · ${it.location}` : ""}
              </Text>
              {it.unit_cost ? (
                <Text className="mt-0.5 text-xs text-slate-400">
                  {formatCurrency(
                    it.unit_cost,
                    it.cost_currency ?? it.properties?.currency ?? "USD",
                  )}{" "}
                  each
                </Text>
              ) : null}
            </Card>
          ))
        )}
      </ScrollView>

      <Modal visible={adding} onRequestClose={() => !saving && setAdding(false)} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[88%] rounded-t-3xl bg-slate-50"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900">
              {editingId ? "Edit item" : "New item"}
            </Text>

            <Field
              label="Name"
              value={name}
              onChangeText={setName}
              placeholder="e.g. AC filters, Paint (white)"
            />

            <Text className="mb-1 text-sm font-medium text-slate-600">
              Property (optional — leave blank for global stock)
            </Text>
            <View className="mb-3 flex-row flex-wrap">
              {properties.map((p) => (
                <Pressable
                  key={p.id}
                  onPress={() =>
                    setPropertyId(propertyId === p.id ? null : p.id)
                  }
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
              label="Quantity on hand"
              value={quantity}
              onChangeText={setQuantity}
              placeholder="0"
              keyboardType="decimal-pad"
            />
            <Field
              label="Low-stock alert at (optional)"
              value={threshold}
              onChangeText={setThreshold}
              placeholder="e.g. 2"
              keyboardType="decimal-pad"
            />
            <Field
              label="Unit cost (optional)"
              value={unitCost}
              onChangeText={setUnitCost}
              placeholder="0.00"
              keyboardType="decimal-pad"
            />
            <Field label="Currency" value={costCurrency} onChangeText={value => setCostCurrency(value.toUpperCase())} autoCapitalize="characters" maxLength={3} />
            <Field
              label="Storage location (optional)"
              value={location}
              onChangeText={setLocation}
              placeholder="e.g. Garage shelf B"
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
                <Button title="Delete item" variant="danger" onPress={remove} />
              </View>
            ) : null}
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
