import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
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
import { cachedSelect } from "../../lib/cache";
import { useOffline } from "../../lib/offline";
import type { Tables } from "../../lib/database.types";
import { Constants } from "../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../lib/format";
import { supabase } from "../../lib/supabase";

function notify(title: string, message: string) {
  Platform.OS === "web"
    ? window.alert(`${title}\n\n${message}`)
    : Alert.alert(title, message);
}

type Asset = Tables<"assets"> & {
  properties: { name: string; currency: string } | null;
  units: { label: string } | null;
};

const STATUSES = Constants.public.Enums.asset_status;

export default function Assets() {
  const router = useRouter();
  const { session } = useAuth();
  const { submitInsert } = useOffline();
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [properties, setProperties] = useState<Tables<"properties">[]>([]);
  const [units, setUnits] = useState<Tables<"units">[]>([]);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  // form
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [warranty, setWarranty] = useState("");
  const [life, setLife] = useState("");
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("operational");

  const load = useCallback(async () => {
    const [a, p] = await Promise.all([
      cachedSelect<Asset[]>(
        "assets",
        supabase
          .from("assets")
          .select("*, properties(name, currency), units(label)")
          .order("created_at", { ascending: false }),
      ),
      cachedSelect<Tables<"properties">[]>(
        "properties_min",
        supabase.from("properties").select("*").order("name"),
      ),
    ]);
    setAssets(a ?? []);
    setProperties(p ?? []);
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
    setName("");
    setCategory("");
    setPropertyId(null);
    setUnitId(null);
    setUnits([]);
    setWarranty("");
    setLife("");
    setStatus("operational");
  }

  async function save() {
    if (!name.trim() || !propertyId || !session) return;
    setSaving(true);
    try {
      const result = await submitInsert("assets", {
        owner_id: session.user.id,
        property_id: propertyId,
        unit_id: unitId,
        name: name.trim(),
        category: category.trim() || null,
        warranty_expiry: warranty.trim() || null,
        expected_life_years: life ? Number(life) : null,
        status,
      });
      setAdding(false);
      resetForm();
      if (result === "queued") {
        notify(
          "Saved offline",
          "This asset will sync automatically when you're back online.",
        );
      } else {
        load();
      }
    } catch (e) {
      notify("Could not save", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!assets) return <Loading />;

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
        <Text className="flex-1 text-xl font-bold text-slate-900">Assets</Text>
        <Pressable onPress={() => router.push("/scan")} className="p-2">
          <Ionicons name="qr-code-outline" size={22} color="#0f766e" />
        </Pressable>
        <Pressable
          onPress={() => setAdding(true)}
          className="flex-row items-center rounded-full bg-brand px-3 py-2"
        >
          <Ionicons name="add" color="#fff" size={18} />
          <Text className="ml-1 font-semibold text-white">Add</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        {assets.length === 0 ? (
          <EmptyState
            title="No assets tracked"
            subtitle="Track appliances, HVAC, and fixtures — make, warranty, and expected life for replacement forecasting."
          />
        ) : (
          assets.map((a) => (
            <Card key={a.id} onPress={() => router.push(`/asset/${a.id}`)}>
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 pr-2 text-base font-semibold text-slate-900">
                  {a.name}
                </Text>
                <Badge label={a.status} />
              </View>
              <Text className="mt-1 text-slate-500">
                {a.category ? `${a.category} · ` : ""}
                {a.properties?.name ?? "—"}
                {a.units?.label ? ` · ${a.units.label}` : ""}
              </Text>
              {a.warranty_expiry ? (
                <Text className="mt-1 text-xs text-slate-400">
                  Warranty until {formatDate(a.warranty_expiry)}
                </Text>
              ) : null}
              {a.purchase_cost ? (
                <Text className="mt-0.5 text-xs text-slate-400">
                  {formatCurrency(
                    a.purchase_cost,
                    a.purchase_currency ?? a.properties?.currency ?? "USD",
                  )}
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
            <Text className="mb-4 text-xl font-bold text-slate-900">New asset</Text>

            <Field
              label="Name"
              value={name}
              onChangeText={setName}
              placeholder="e.g. Split AC unit, Refrigerator"
            />
            <Field
              label="Category (optional)"
              value={category}
              onChangeText={setCategory}
              placeholder="HVAC, Appliance, Plumbing…"
            />

            <Text className="mb-1 text-sm font-medium text-slate-600">Property</Text>
            {properties.length === 0 ? (
              <Text className="mb-3 text-slate-400">Add a property first.</Text>
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
                  Unit (optional — leave blank for shared/common)
                </Text>
                <View className="mb-3 flex-row flex-wrap">
                  {units.map((u) => (
                    <Pressable
                      key={u.id}
                      onPress={() => setUnitId(unitId === u.id ? null : u.id)}
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

            <Field
              label="Warranty expiry (YYYY-MM-DD, optional)"
              value={warranty}
              onChangeText={setWarranty}
              placeholder="2028-01-31"
              autoCapitalize="none"
            />
            <Field
              label="Expected life (years, optional)"
              value={life}
              onChangeText={setLife}
              placeholder="10"
              keyboardType="number-pad"
            />

            <Text className="mb-1 text-sm font-medium text-slate-600">Status</Text>
            <View className="mb-3 flex-row flex-wrap">
              {STATUSES.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => setStatus(s)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    status === s ? "border-brand bg-brand" : "border-slate-300 bg-white"
                  }`}
                >
                  <Text
                    className={status === s ? "font-medium text-white" : "text-slate-700"}
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
                <Button title="Save" onPress={save} loading={saving} />
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
