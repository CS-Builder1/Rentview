import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
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
import type { Tables } from "../../lib/database.types";
import { Constants } from "../../lib/database.types";
import { formatDate, titleCase } from "../../lib/format";
import { supabase } from "../../lib/supabase";

type WorkOrder = Tables<"work_orders"> & {
  properties: { name: string } | null;
  units: { label: string } | null;
};

const PRIORITIES = Constants.public.Enums.wo_priority;

export default function WorkOrders() {
  const router = useRouter();
  const { session } = useAuth();
  const [orders, setOrders] = useState<WorkOrder[] | null>(null);
  const [properties, setProperties] = useState<Tables<"properties">[]>([]);
  const [units, setUnits] = useState<Tables<"units">[]>([]);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  // form
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("medium");

  const load = useCallback(async () => {
    const [wo, props] = await Promise.all([
      supabase
        .from("work_orders")
        .select("*, properties(name), units(label)")
        .order("created_at", { ascending: false }),
      supabase.from("properties").select("*").order("name"),
    ]);
    setOrders((wo.data as WorkOrder[]) ?? []);
    setProperties(props.data ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function pickProperty(pid: string) {
    setPropertyId(pid);
    setUnitId(null);
    const { data } = await supabase
      .from("units")
      .select("*")
      .eq("property_id", pid)
      .order("label");
    setUnits(data ?? []);
  }

  function resetForm() {
    setTitle("");
    setDescription("");
    setPropertyId(null);
    setUnitId(null);
    setUnits([]);
    setPriority("medium");
  }

  async function save() {
    if (!title.trim() || !propertyId || !session) return;
    setSaving(true);
    const { error } = await supabase.from("work_orders").insert({
      owner_id: session.user.id,
      property_id: propertyId,
      unit_id: unitId,
      title: title.trim(),
      description: description.trim() || null,
      priority,
    });
    setSaving(false);
    if (!error) {
      setAdding(false);
      resetForm();
      load();
    }
  }

  if (!orders) return <Loading />;

  return (
    <Screen>
      <View className="flex-row items-center justify-between px-5 pb-2 pt-2">
        <Text className="text-2xl font-bold text-slate-900">Work Orders</Text>
        <Pressable
          onPress={() => setAdding(true)}
          className="flex-row items-center rounded-full bg-brand px-3 py-2"
        >
          <Ionicons name="add" color="#fff" size={18} />
          <Text className="ml-1 font-semibold text-white">New</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        {orders.length === 0 ? (
          <EmptyState
            title="No work orders"
            subtitle="Log a maintenance job against any property or unit."
          />
        ) : (
          orders.map((o) => (
            <Card key={o.id} onPress={() => router.push(`/work-order/${o.id}`)}>
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 pr-2 text-base font-semibold text-slate-900">
                  {o.title}
                </Text>
                <Badge label={o.priority} />
              </View>
              <Text className="mt-1 text-slate-500">
                {o.properties?.name ?? "—"}
                {o.units?.label ? ` · ${o.units.label}` : ""}
              </Text>
              <View className="mt-2 flex-row items-center justify-between">
                <Badge label={o.status} />
                <Text className="text-xs text-slate-400">
                  {formatDate(o.created_at)}
                </Text>
              </View>
            </Card>
          ))
        )}
      </ScrollView>

      <Modal visible={adding} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[85%] rounded-t-3xl bg-slate-50"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900">
              New work order
            </Text>

            <Field
              label="Title"
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Leaking kitchen tap"
            />
            <Field
              label="Description (optional)"
              value={description}
              onChangeText={setDescription}
              placeholder="Details, location, what's needed…"
              multiline
            />

            <Text className="mb-1 text-sm font-medium text-slate-600">
              Property
            </Text>
            {properties.length === 0 ? (
              <Text className="mb-3 text-slate-400">
                Add a property first under the Properties tab.
              </Text>
            ) : (
              <View className="mb-3 flex-row flex-wrap">
                {properties.map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => pickProperty(p.id)}
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
            )}

            {units.length > 0 ? (
              <>
                <Text className="mb-1 text-sm font-medium text-slate-600">
                  Unit (optional)
                </Text>
                <View className="mb-3 flex-row flex-wrap">
                  {units.map((u) => (
                    <Pressable
                      key={u.id}
                      onPress={() =>
                        setUnitId(unitId === u.id ? null : u.id)
                      }
                      className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                        unitId === u.id
                          ? "border-brand bg-brand"
                          : "border-slate-300 bg-white"
                      }`}
                    >
                      <Text
                        className={
                          unitId === u.id
                            ? "font-medium text-white"
                            : "text-slate-700"
                        }
                      >
                        {u.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}

            <Text className="mb-1 text-sm font-medium text-slate-600">
              Priority
            </Text>
            <View className="mb-3 flex-row flex-wrap">
              {PRIORITIES.map((p) => (
                <Pressable
                  key={p}
                  onPress={() => setPriority(p)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    priority === p
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  <Text
                    className={
                      priority === p ? "font-medium text-white" : "text-slate-700"
                    }
                  >
                    {titleCase(p)}
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
                <Button title="Save" onPress={save} loading={saving} />
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
