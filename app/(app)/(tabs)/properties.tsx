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
} from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import { cachedSelect } from "../../../lib/cache";
import type { Tables } from "../../../lib/database.types";
import { Constants } from "../../../lib/database.types";
import { titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";

type Property = Tables<"properties"> & { units: { count: number }[] };

const PROPERTY_TYPES = Constants.public.Enums.property_type;

export default function Properties() {
  const router = useRouter();
  const { session } = useAuth();
  const [properties, setProperties] = useState<Property[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  // form
  const [name, setName] = useState("");
  const [type, setType] = useState<(typeof PROPERTY_TYPES)[number]>("residential");
  const [city, setCity] = useState("");
  const [currency, setCurrency] = useState("USD");

  const load = useCallback(async () => {
    const data = await cachedSelect<Property[]>(
      "properties",
      supabase
        .from("properties")
        .select("*, units(count)")
        .order("created_at", { ascending: true }),
    );
    setProperties(data ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function resetForm() {
    setName("");
    setType("residential");
    setCity("");
    setCurrency("USD");
  }

  async function save() {
    if (!name.trim() || !session) return;
    setSaving(true);
    const { error } = await supabase.from("properties").insert({
      owner_id: session.user.id,
      name: name.trim(),
      property_type: type,
      city: city.trim() || null,
      currency: currency.trim() || "USD",
    });
    setSaving(false);
    if (!error) {
      setAdding(false);
      resetForm();
      load();
    }
  }

  if (!properties) return <Loading />;

  return (
    <Screen>
      <View className="flex-row items-center justify-between px-5 pb-2 pt-2">
        <Text className="text-2xl font-bold text-slate-900">Properties</Text>
        <Pressable
          onPress={() => setAdding(true)}
          className="flex-row items-center rounded-full bg-brand px-3 py-2"
        >
          <Ionicons name="add" color="#fff" size={18} />
          <Text className="ml-1 font-semibold text-white">Add</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        {properties.length === 0 ? (
          <EmptyState
            title="No properties yet"
            subtitle="Add your first property — a single home, a store, or a complex with many units."
          />
        ) : (
          properties.map((p) => (
            <Card key={p.id} onPress={() => router.push(`/property/${p.id}`)}>
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 text-lg font-semibold text-slate-900">
                  {p.name}
                </Text>
                <Badge label={p.property_type} />
              </View>
              <Text className="mt-1 text-slate-500">
                {p.city ? `${p.city} · ` : ""}
                {p.units?.[0]?.count ?? 0} unit
                {(p.units?.[0]?.count ?? 0) === 1 ? "" : "s"}
              </Text>
            </Card>
          ))
        )}
      </ScrollView>

      <Modal visible={adding} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <View className="rounded-t-3xl bg-slate-50 p-5">
            <Text className="mb-4 text-xl font-bold text-slate-900">
              New property
            </Text>

            <Field
              label="Name"
              value={name}
              onChangeText={setName}
              placeholder="e.g. Marigot Bay Complex"
            />

            <Text className="mb-1 text-sm font-medium text-slate-600">Type</Text>
            <View className="mb-3 flex-row flex-wrap">
              {PROPERTY_TYPES.map((t) => (
                <Pressable
                  key={t}
                  onPress={() => setType(t)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    type === t
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  <Text
                    className={
                      type === t ? "font-medium text-white" : "text-slate-700"
                    }
                  >
                    {titleCase(t)}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Field
              label="City / area (optional)"
              value={city}
              onChangeText={setCity}
              placeholder="Castries"
            />
            <Field
              label="Currency"
              value={currency}
              onChangeText={(v) => setCurrency(v.toUpperCase())}
              placeholder="USD / XCD / EUR"
              autoCapitalize="characters"
              maxLength={3}
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
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
