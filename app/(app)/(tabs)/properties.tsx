import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";

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
import { cachedSelectResult } from "../../../lib/cache";
import type { Tables } from "../../../lib/database.types";
import { Constants } from "../../../lib/database.types";
import { titleCase } from "../../../lib/format";
import { usePlan } from "../../../lib/plan";
import { supabase } from "../../../lib/supabase";
import { createOnce } from "../../../lib/createOnce";
import { newRecordId } from "../../../lib/id";
import { notify } from "../../../lib/feedback";
import { currencyCode } from "../../../lib/validation";
import { operationError, readAllPages } from "../../../lib/operationsQuery";

type Property = Tables<"properties"> & { units: { count: number }[] };

const PROPERTY_TYPES = Constants.public.Enums.property_type;

export default function Properties() {
  const router = useRouter();
  const generation = useRef(0);
  const draftId = useRef<string | null>(null);
  const typeControls = useRef<Array<{ focus: () => void } | null>>([]);
  const { session } = useAuth();
  const { propertyLimit } = usePlan();
  const [properties, setProperties] = useState<Property[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // form
  const [name, setName] = useState("");
  const [type, setType] = useState<(typeof PROPERTY_TYPES)[number]>("residential");
  const [city, setCity] = useState("");
  const [currency, setCurrency] = useState("USD");

  const load = useCallback(async () => {
    const ticket = ++generation.current;
    const result = await cachedSelectResult<Property[]>("properties",
      readAllPages<Property>((from, to) => supabase.from("properties")
        .select("*, units!units_property_id_owner_fk(count)", { count: "exact" })
        .order("created_at", { ascending: true }).order("id").range(from, to)));
    if (ticket !== generation.current) return;
    setLoadError(result.error);
    setProperties(result.data ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => { generation.current++; setAdding(false); };
    }, [load]),
  );

  function selectTypeWithKey(index: number, event: { key: string; preventDefault: () => void }) {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % PROPERTY_TYPES.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + PROPERTY_TYPES.length - 1) % PROPERTY_TYPES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = PROPERTY_TYPES.length - 1;
    else if (event.key !== " " && event.key !== "Spacebar") return;
    event.preventDefault();
    setType(PROPERTY_TYPES[next]);
    typeControls.current[next]?.focus();
  }

  /**
   * The Free tier caps how many properties an account can hold. Everything
   * already created stays fully usable — only adding another is blocked.
   */
  function startAdd() {
    const count = properties?.length ?? 0;
    if (propertyLimit !== null && count >= propertyLimit) {
      const message =
        `Free covers ${propertyLimit} propert${propertyLimit === 1 ? "y" : "ies"}. ` +
        "Upgrade to Pro under More → Plan & billing to add more. Everything you " +
        "have already stays as it is.";
      notify("Property limit reached", message);
      return;
    }
    setAdding(true);
  }

  function resetForm() {
    draftId.current = null;
    setName("");
    setType("residential");
    setCity("");
    setCurrency("USD");
  }

  async function save() {
    if (!name.trim() || !session) { notify("Missing name", "Enter a property name."); return; }
    setSaving(true);
    try {
      draftId.current ??= newRecordId();
      const payload = { id: draftId.current, owner_id: session.user.id,
        name: name.trim(), property_type: type, city: city.trim() || null, currency: currencyCode(currency) };
      const data = await createOnce(payload,
        () => supabase.from("properties").insert(payload).select("id").single(),
        () => supabase.from("properties").select("*").eq("id", payload.id).single());
      setAdding(false); resetForm();
      router.push(`/property/${data.id}`);
    } catch (error) { notify("Could not save property", operationError(error)); }
    finally { setSaving(false); }
  }

  if (!properties) return <Loading />;

  return (
    <Screen>
      <View className="flex-row items-center justify-between px-5 pb-2 pt-2">
        <Text className="text-2xl font-bold text-slate-900">Properties</Text>
        <Pressable
          accessibilityRole="button" accessibilityLabel="Add property" onPress={startAdd}
          className="flex-row items-center rounded-full bg-brand px-3 py-2"
        >
          <Ionicons name="add" color="#fff" size={18} />
          <Text className="ml-1 font-semibold text-white">Add</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        <Field label="Search properties" value={search} onChangeText={setSearch} placeholder="Name or city" />
        {loadError ? <View className="mb-3"><Text accessibilityRole="alert" className="mb-2 text-red-700">{loadError}</Text><Button title="Retry" variant="secondary" onPress={() => void load()} /></View> : null}
        {properties.length === 0 && !loadError ? (
          <EmptyState
            title="No properties yet"
            subtitle="Add your first property — a single home, a store, or a complex with many units."
          />
        ) : (
          properties.filter(p => `${p.name} ${p.city ?? ""}`.toLowerCase().includes(search.toLowerCase())).map((p) => (
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

      {adding ? <Modal visible onRequestClose={() => !saving && setAdding(false)} animationType="slide" transparent>
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
            <View accessibilityRole="radiogroup" accessibilityLabel="Property type" className="mb-3 flex-row flex-wrap">
              {PROPERTY_TYPES.map((t, index) => (
                <Pressable
                  key={t}
                  ref={(control) => { typeControls.current[index] = control; }}
                  accessibilityRole="radio"
                  accessibilityLabel={titleCase(t)}
                  accessibilityState={{ checked: type === t }}
                  aria-checked={type === t}
                  {...(Platform.OS === "web" ? {
                    tabIndex: type === t ? 0 as const : -1 as const,
                    onKeyDown: (event: { key: string; preventDefault: () => void }) => selectTypeWithKey(index, event),
                  } : {})}
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
                  disabled={saving}
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
      </Modal> : null}
    </Screen>
  );
}
