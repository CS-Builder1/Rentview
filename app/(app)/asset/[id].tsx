import { Ionicons } from "@expo/vector-icons";
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { DocumentsSection } from "../../../components/DocumentsSection";
import { Badge, Card, Loading, Screen } from "../../../components/ui";
import type { Tables } from "../../../lib/database.types";
import { formatCurrency, formatDate } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";

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

  const load = useCallback(async () => {
    if (!id) return;
    const { data } = await supabase
      .from("assets")
      .select("*, properties(name, currency), units(label)")
      .eq("id", id)
      .single();
    setAsset((data as Asset) ?? null);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

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
    </Screen>
  );
}
