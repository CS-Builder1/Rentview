import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";

import { DocumentsSection } from "../../../components/DocumentsSection";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Loading,
  Screen,
} from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import type { Tables } from "../../../lib/database.types";
import { Constants } from "../../../lib/database.types";
import { formatCurrency, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";

const UNIT_TYPES = Constants.public.Enums.unit_type;
const UNIT_STATUSES = Constants.public.Enums.unit_status;

export default function PropertyDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();

  const [property, setProperty] = useState<Tables<"properties"> | null>(null);
  const [units, setUnits] = useState<Tables<"units">[] | null>(null);
  const [assets, setAssets] = useState<Tables<"assets">[]>([]);
  const [openWorkOrders, setOpenWorkOrders] = useState<Tables<"work_orders">[]>(
    [],
  );
  const [spend, setSpend] = useState(0);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  // unit form
  const [label, setLabel] = useState("");
  const [unitType, setUnitType] =
    useState<(typeof UNIT_TYPES)[number]>("apartment");
  const [status, setStatus] =
    useState<(typeof UNIT_STATUSES)[number]>("vacant");
  const [rent, setRent] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    const [prop, unitRows, assetRows, woRows, expenseRows] = await Promise.all([
      supabase.from("properties").select("*").eq("id", id).single(),
      supabase
        .from("units")
        .select("*")
        .eq("property_id", id)
        .order("created_at", { ascending: true }),
      supabase
        .from("assets")
        .select("*")
        .eq("property_id", id)
        .order("created_at", { ascending: true }),
      supabase
        .from("work_orders")
        .select("*")
        .eq("property_id", id)
        .in("status", ["open", "in_progress", "on_hold"])
        .order("created_at", { ascending: false }),
      supabase.from("expenses").select("amount").eq("property_id", id),
    ]);
    setProperty(prop.data ?? null);
    setUnits(unitRows.data ?? []);
    setAssets(assetRows.data ?? []);
    setOpenWorkOrders(woRows.data ?? []);
    setSpend(
      (expenseRows.data ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0),
    );
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function resetForm() {
    setLabel("");
    setUnitType("apartment");
    setStatus("vacant");
    setRent("");
  }

  async function saveUnit() {
    if (!label.trim() || !session || !id) return;
    setSaving(true);
    const { error } = await supabase.from("units").insert({
      owner_id: session.user.id,
      property_id: id,
      label: label.trim(),
      unit_type: unitType,
      status,
      rent_amount: rent ? Number(rent) : null,
      rent_currency: property?.currency ?? "USD",
    });
    setSaving(false);
    if (!error) {
      setAdding(false);
      resetForm();
      load();
    }
  }

  if (!property || !units) return <Loading />;

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
        <Text className="flex-1 text-xl font-bold text-slate-900" numberOfLines={1}>
          {property.name}
        </Text>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        <Card>
          <View className="flex-row items-center justify-between">
            <Badge label={property.property_type} />
            <Text className="text-slate-500">{property.currency}</Text>
          </View>
          {property.city ? (
            <Text className="mt-2 text-slate-600">{property.city}</Text>
          ) : null}
          {property.estimated_value ? (
            <Text className="mt-1 text-slate-500">
              Est. value{" "}
              {formatCurrency(property.estimated_value, property.currency)}
            </Text>
          ) : null}
        </Card>

        <View className="mb-2 mt-4 flex-row items-center justify-between">
          <Text className="text-lg font-semibold text-slate-900">
            Units ({units.length})
          </Text>
          <Pressable
            onPress={() => setAdding(true)}
            className="flex-row items-center rounded-full bg-brand px-3 py-1.5"
          >
            <Ionicons name="add" color="#fff" size={16} />
            <Text className="ml-1 font-semibold text-white">Add unit</Text>
          </Pressable>
        </View>

        {units.length === 0 ? (
          <EmptyState
            title="No units yet"
            subtitle="A complex can hold many units, each a different type. A single home or store needs just one."
          />
        ) : (
          units.map((u) => (
            <Card key={u.id} onPress={() => router.push(`/unit/${u.id}`)}>
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 text-base font-semibold text-slate-900">
                  {u.label}
                </Text>
                <Badge label={u.status} />
              </View>
              <View className="mt-1 flex-row items-center">
                <Text className="text-slate-500">{titleCase(u.unit_type)}</Text>
                {u.rent_amount ? (
                  <Text className="text-slate-500">
                    {"  ·  "}
                    {formatCurrency(u.rent_amount, u.rent_currency ?? property.currency)}
                  </Text>
                ) : null}
              </View>
            </Card>
          ))
        )}

        {/* Open work orders for this property */}
        <Text className="mb-2 mt-4 text-lg font-semibold text-slate-900">
          Open work orders ({openWorkOrders.length})
        </Text>
        {openWorkOrders.length === 0 ? (
          <Text className="mb-2 text-slate-400">None open.</Text>
        ) : (
          openWorkOrders.map((w) => (
            <Card
              key={w.id}
              onPress={() => router.push(`/work-order/${w.id}`)}
            >
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 pr-2 text-slate-800">{w.title}</Text>
                <Badge label={w.priority} />
              </View>
            </Card>
          ))
        )}

        {/* Assets for this property */}
        <Text className="mb-2 mt-4 text-lg font-semibold text-slate-900">
          Assets ({assets.length})
        </Text>
        {assets.length === 0 ? (
          <Text className="mb-2 text-slate-400">No assets tracked.</Text>
        ) : (
          assets.map((a) => (
            <Card key={a.id} onPress={() => router.push(`/asset/${a.id}`)}>
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 pr-2 text-slate-800">{a.name}</Text>
                <Badge label={a.status} />
              </View>
              {a.category ? (
                <Text className="mt-1 text-slate-500">{a.category}</Text>
              ) : null}
            </Card>
          ))
        )}

        {/* Property-level documents (leases, insurance, etc.) */}
        <DocumentsSection scope={{ kind: "property", propertyId: property.id }} />

        {/* Spend */}
        <Card>
          <View className="flex-row items-center justify-between">
            <Text className="text-slate-600">Total spend tracked</Text>
            <Text className="text-lg font-bold text-slate-900">
              {formatCurrency(spend, property.currency)}
            </Text>
          </View>
        </Card>
      </ScrollView>

      <Modal visible={adding} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[85%] rounded-t-3xl bg-slate-50"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900">New unit</Text>

            <Field
              label="Label"
              value={label}
              onChangeText={setLabel}
              placeholder="e.g. Apt 2B, Storefront, Main House"
            />

            <Text className="mb-1 text-sm font-medium text-slate-600">Type</Text>
            <View className="mb-3 flex-row flex-wrap">
              {UNIT_TYPES.map((t) => (
                <Pressable
                  key={t}
                  onPress={() => setUnitType(t)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    unitType === t
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  <Text
                    className={
                      unitType === t ? "font-medium text-white" : "text-slate-700"
                    }
                  >
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
                  onPress={() => setStatus(s)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    status === s
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  <Text
                    className={
                      status === s ? "font-medium text-white" : "text-slate-700"
                    }
                  >
                    {titleCase(s)}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Field
              label={`Rent (${property.currency}, optional)`}
              value={rent}
              onChangeText={setRent}
              placeholder="0.00"
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
                <Button title="Save" onPress={saveUnit} loading={saving} />
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
