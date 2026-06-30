import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
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
import type { Tables } from "../../lib/database.types";
import { formatCurrency } from "../../lib/format";
import { supabase } from "../../lib/supabase";

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
  const { session } = useAuth();
  const [items, setItems] = useState<Item[] | null>(null);
  const [properties, setProperties] = useState<Tables<"properties">[]>([]);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  // form
  const [name, setName] = useState("");
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("");
  const [threshold, setThreshold] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [location, setLocation] = useState("");

  const load = useCallback(async () => {
    const [i, p] = await Promise.all([
      supabase
        .from("inventory_items")
        .select("*, properties(name, currency)")
        .order("name"),
      supabase.from("properties").select("*").order("name"),
    ]);
    setItems((i.data as Item[]) ?? []);
    setProperties(p.data ?? []);
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
  }

  async function save() {
    if (!name.trim() || !session) return;
    setSaving(true);
    const { error } = await supabase.from("inventory_items").insert({
      owner_id: session.user.id,
      property_id: propertyId,
      name: name.trim(),
      quantity: quantity ? Number(quantity) : 0,
      low_stock_threshold: threshold ? Number(threshold) : null,
      unit_cost: unitCost ? Number(unitCost) : null,
      location: location.trim() || null,
    });
    setSaving(false);
    if (!error) {
      setAdding(false);
      resetForm();
      load();
    }
  }

  if (!items) return <Loading />;

  const lowCount = items.filter(isLow).length;

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
          Inventory & parts
        </Text>
        <Pressable
          onPress={() => setAdding(true)}
          className="flex-row items-center rounded-full bg-brand px-3 py-2"
        >
          <Ionicons name="add" color="#fff" size={18} />
          <Text className="ml-1 font-semibold text-white">Add</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        {lowCount > 0 ? (
          <View className="mb-3 rounded-xl bg-amber-100 px-4 py-3">
            <Text className="font-medium text-amber-800">
              {lowCount} item{lowCount === 1 ? "" : "s"} at or below low-stock level.
            </Text>
          </View>
        ) : null}

        {items.length === 0 ? (
          <EmptyState
            title="No supplies tracked"
            subtitle="Log parts and supplies on hand, set low-stock alerts, and link consumption to work orders."
          />
        ) : (
          items.map((it) => (
            <Card key={it.id}>
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

      <Modal visible={adding} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[88%] rounded-t-3xl bg-slate-50"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900">New item</Text>

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
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
