import { Ionicons } from "@expo/vector-icons";
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useCallback, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";

import { DocumentsSection } from "../../../components/DocumentsSection";
import { Badge, Button, Card, Field, Loading, Screen } from "../../../components/ui";
import { cachedSelect } from "../../../lib/cache";
import { confirmAction } from "../../../lib/confirm";
import type { Tables } from "../../../lib/database.types";
import { Constants } from "../../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";

const ASSET_STATUSES = Constants.public.Enums.asset_status;

type Asset = Tables<"assets"> & {
  properties: { name: string; currency: string } | null;
  units: { label: string } | null;
};

function warrantyState(expiry: string | null): {
  label: string;
  tone: string;
} | null {
  if (!expiry) return null;
  const days = Math.ceil(
    (new Date(expiry).getTime() - Date.now()) / 86400000,
  );
  if (days < 0) return { label: "Warranty expired", tone: "text-red-600" };
  if (days <= 60)
    return { label: `Warranty expires in ${days} days`, tone: "text-amber-600" };
  return { label: "Under warranty", tone: "text-green-700" };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between border-b border-slate-100 py-2">
      <Text className="text-slate-500">{label}</Text>
      <Text className="font-medium text-slate-800">{value}</Text>
    </View>
  );
}

export default function AssetDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [asset, setAsset] = useState<Asset | null>(null);

  // edit modal
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [eName, setEName] = useState("");
  const [eCategory, setECategory] = useState("");
  const [eMake, setEMake] = useState("");
  const [eModel, setEModel] = useState("");
  const [eSerial, setESerial] = useState("");
  const [eInstall, setEInstall] = useState("");
  const [eWarranty, setEWarranty] = useState("");
  const [eLife, setELife] = useState("");
  const [eCost, setECost] = useState("");
  const [eStatus, setEStatus] =
    useState<(typeof ASSET_STATUSES)[number]>("operational");

  const load = useCallback(async () => {
    if (!id) return;
    const data = await cachedSelect<Asset>(
      `asset:${id}`,
      supabase
        .from("assets")
        .select("*, properties(name, currency), units(label)")
        .eq("id", id)
        .single(),
    );
    setAsset(data ?? null);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function openEdit() {
    if (!asset) return;
    setEName(asset.name);
    setECategory(asset.category ?? "");
    setEMake(asset.make ?? "");
    setEModel(asset.model ?? "");
    setESerial(asset.serial_number ?? "");
    setEInstall(asset.install_date ?? "");
    setEWarranty(asset.warranty_expiry ?? "");
    setELife(asset.expected_life_years != null ? String(asset.expected_life_years) : "");
    setECost(asset.purchase_cost != null ? String(asset.purchase_cost) : "");
    setEStatus(asset.status);
    setEditing(true);
  }

  async function saveEdit() {
    if (!eName.trim() || !id) return;
    setSaving(true);
    const { error } = await supabase
      .from("assets")
      .update({
        name: eName.trim(),
        category: eCategory.trim() || null,
        make: eMake.trim() || null,
        model: eModel.trim() || null,
        serial_number: eSerial.trim() || null,
        install_date: eInstall.trim() || null,
        warranty_expiry: eWarranty.trim() || null,
        expected_life_years: eLife ? Number(eLife) : null,
        purchase_cost: eCost ? Number(eCost) : null,
        status: eStatus,
      })
      .eq("id", id);
    setSaving(false);
    if (!error) {
      setEditing(false);
      load();
    }
  }

  function deleteAsset() {
    confirmAction(
      "Delete asset",
      "This permanently deletes the asset. Work orders and documents are kept but unlinked from it. This cannot be undone.",
      async () => {
        if (!asset) return;
        await supabase.from("assets").delete().eq("id", asset.id);
        router.replace("/assets");
      },
    );
  }

  if (!asset) return <Loading />;

  const currency = asset.properties?.currency ?? "USD";
  const warranty = warrantyState(asset.warranty_expiry);

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/assets")
          }
          className="p-2"
        >
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text
          className="flex-1 text-xl font-bold text-slate-900"
          numberOfLines={1}
        >
          {asset.name}
        </Text>
        <Pressable onPress={openEdit} className="p-2">
          <Ionicons name="create-outline" size={22} color="#0f766e" />
        </Pressable>
        <Pressable onPress={deleteAsset} className="p-2">
          <Ionicons name="trash-outline" size={22} color="#dc2626" />
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-12">
        <Card>
          <View className="flex-row items-center justify-between">
            <Badge label={asset.status} />
            <Text className="text-slate-500">
              {asset.properties?.name ?? "—"}
              {asset.units?.label ? ` · ${asset.units.label}` : " · Shared"}
            </Text>
          </View>
          {warranty ? (
            <View className="mt-3 flex-row items-center">
              <Ionicons name="shield-checkmark-outline" size={18} color="#475569" />
              <Text className={`ml-2 font-medium ${warranty.tone}`}>
                {warranty.label}
              </Text>
            </View>
          ) : null}
        </Card>

        <View className="mt-2">
          <Card>
            {asset.category ? <Row label="Category" value={asset.category} /> : null}
            {asset.make ? <Row label="Make" value={asset.make} /> : null}
            {asset.model ? <Row label="Model" value={asset.model} /> : null}
            {asset.serial_number ? (
              <Row label="Serial" value={asset.serial_number} />
            ) : null}
            {asset.install_date ? (
              <Row label="Installed" value={formatDate(asset.install_date)} />
            ) : null}
            {asset.warranty_expiry ? (
              <Row
                label="Warranty until"
                value={formatDate(asset.warranty_expiry)}
              />
            ) : null}
            {asset.expected_life_years ? (
              <Row
                label="Expected life"
                value={`${asset.expected_life_years} years`}
              />
            ) : null}
            {asset.purchase_cost ? (
              <Row
                label="Purchase cost"
                value={formatCurrency(
                  asset.purchase_cost,
                  asset.purchase_currency ?? currency,
                )}
              />
            ) : null}
          </Card>
        </View>

        <DocumentsSection
          scope={{
            kind: "asset",
            assetId: asset.id,
            propertyId: asset.property_id,
            unitId: asset.unit_id,
          }}
          defaultDocType="warranty"
        />
      </ScrollView>

      <Modal visible={editing} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[90%] rounded-t-3xl bg-slate-50"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900">Edit asset</Text>
            <Field label="Name" value={eName} onChangeText={setEName} />
            <Field label="Category" value={eCategory} onChangeText={setECategory} />
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Field label="Make" value={eMake} onChangeText={setEMake} />
              </View>
              <View className="flex-1">
                <Field label="Model" value={eModel} onChangeText={setEModel} />
              </View>
            </View>
            <Field label="Serial number" value={eSerial} onChangeText={setESerial} />
            <Field
              label="Installed (YYYY-MM-DD)"
              value={eInstall}
              onChangeText={setEInstall}
              placeholder="2023-05-10"
              autoCapitalize="none"
            />
            <Field
              label="Warranty expiry (YYYY-MM-DD)"
              value={eWarranty}
              onChangeText={setEWarranty}
              placeholder="2026-05-10"
              autoCapitalize="none"
            />
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Field
                  label="Expected life (yrs)"
                  value={eLife}
                  onChangeText={setELife}
                  keyboardType="number-pad"
                />
              </View>
              <View className="flex-1">
                <Field
                  label={`Cost (${currency})`}
                  value={eCost}
                  onChangeText={setECost}
                  keyboardType="decimal-pad"
                />
              </View>
            </View>
            <Text className="mb-1 text-sm font-medium text-slate-600">Status</Text>
            <View className="mb-3 flex-row flex-wrap">
              {ASSET_STATUSES.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => setEStatus(s)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    eStatus === s ? "border-brand bg-brand" : "border-slate-300 bg-white"
                  }`}
                >
                  <Text className={eStatus === s ? "font-medium text-white" : "text-slate-700"}>
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
    </Screen>
  );
}
