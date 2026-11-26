import { Ionicons } from "@expo/vector-icons";
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, Share, Text, View } from "react-native";

import QRCode from "react-native-qrcode-svg";

import { DocumentsSection } from "../../../components/DocumentsSection";
import { Badge, Button, Card, EmptyState, Field, Loading, Screen } from "../../../components/ui";
import { assetUrl } from "../../../lib/appUrl";
import { cachedSelectResult } from "../../../lib/cache";
import { confirmAction } from "../../../lib/confirm";
import type { Tables } from "../../../lib/database.types";
import { Constants } from "../../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";
import { operationError } from "../../../lib/operationsQuery";
import { notify } from "../../../lib/feedback";
import { localToday, positiveNumber, validCalendarDate } from "../../../lib/maintenance";

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
    (new Date(`${expiry}T12:00:00Z`).getTime() - new Date(`${localToday()}T12:00:00Z`).getTime()) / 86400000,
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
  const [loaded, setLoaded] = useState(false), [loadError, setLoadError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Tables<"work_orders">[]>([]);
  const [schedules, setSchedules] = useState<Tables<"maintenance_schedules">[]>([]);
  const [costTotals, setCostTotals] = useState<{ currency: string; total: number }[]>([]);
  const qrRef = useRef<{ toDataURL: (cb: (data: string) => void) => void } | null>(null);

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
    const [result, jobResult, scheduleResult, totals] = await Promise.all([
      cachedSelectResult<Asset>(`asset:${id}`, supabase.from("assets").select("*, properties!assets_property_id_owner_fk(name, currency), units!assets_unit_property_owner_fk(label)").eq("id", id).single()),
      cachedSelectResult<Tables<"work_orders">[]>(`asset:${id}:jobs`, supabase.from("work_orders").select("*").eq("asset_id", id).order("created_at", { ascending: false }).limit(50)),
      cachedSelectResult<Tables<"maintenance_schedules">[]>(`asset:${id}:schedules`, supabase.from("maintenance_schedules").select("*").eq("asset_id", id).eq("is_active", true).order("next_due", { ascending: true, nullsFirst: false })),
      supabase.rpc("asset_cost_totals", { p_asset_id: id }),
    ]);
    setAsset(result.data); setJobs(jobResult.data ?? []); setSchedules(scheduleResult.data ?? []); setCostTotals(totals.data ?? []);
    setLoadError(result.error || jobResult.error || scheduleResult.error || totals.error?.message || null); setLoaded(true);
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
    if (!eName.trim() || !id) { notify("Missing name", "Enter an asset name."); return; }
    try {
      if ((eInstall && !validCalendarDate(eInstall)) || (eWarranty && !validCalendarDate(eWarranty))) throw new Error("Choose valid calendar dates in YYYY-MM-DD format.");
      if (eLife && !Number.isSafeInteger(positiveNumber(eLife, "Expected life"))) throw new Error("Expected life must be a whole number of years.");
      if (eCost) positiveNumber(eCost, "Purchase cost", true);
    } catch (e) { notify("Check asset details", operationError(e)); return; }
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
      .eq("id", id).select("id").single();
    setSaving(false);
    if (error) { notify("Could not save asset", error.message); return; }
    setEditing(false); await load();
  }

  function deleteAsset() {
    confirmAction(
      "Retire asset",
      "Mark this asset out of service while retaining its jobs, costs and documents. You can restore its status later.",
      async () => {
        if (!asset) return;
        const { error } = await supabase.from("assets").update({ status: "out_of_service" }).eq("id", asset.id).select("id").single();
        if (error) { notify("Could not retire asset", error.message); return; }
        await load();
      },
      "Retire",
    );
  }

  if (!asset) return loaded ? <Screen><EmptyState title="Asset unavailable" subtitle={loadError || "It may have been removed or your access may have changed."} /><Button title="Retry" variant="secondary" onPress={() => void load()} /><Button title="Back to assets" onPress={() => router.replace("/assets")} /></Screen> : <Loading />;
  async function shareAsset() { try { await Share.share({ title: asset!.name, message: `${asset!.name}\n${assetUrl(asset!.id)}` }); } catch (e) { notify("Could not share asset", operationError(e)); } }
  function printLabel() {
    if (Platform.OS !== "web") { void shareAsset(); return; }
    const label = window.open("", "_blank");
    if (!label) { notify("Allow a new tab", "Allow pop-ups to print this asset label."); return; }
    label.opener = null;
    const title = label.document.createElement("h1"); title.textContent = asset!.name;
    const location = label.document.createElement("p"); location.textContent = [asset!.properties?.name, asset!.units?.label || "Shared / common"].filter(Boolean).join(" · ");
    label.document.body.style.fontFamily = "system-ui, sans-serif"; label.document.body.style.textAlign = "center";
    label.document.title = `${asset!.name} · RentView label`; label.document.body.append(title, location);
    qrRef.current?.toDataURL(data => { const image = label.document.createElement("img"); image.width = 220; image.height = 220; image.alt = "Asset QR code"; image.onload = () => { label.focus(); label.print(); }; image.src = `data:image/png;base64,${data}`; label.document.body.append(image); });
  }

  let qrUrl: string | null = null;
  try { qrUrl = assetUrl(asset.id); } catch { /* Sharing must fail soft when the web address is missing. */ }
  const currency = asset.properties?.currency ?? "USD";
  const warranty = warrantyState(asset.warranty_expiry);

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
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
        <Pressable accessibilityRole="button" accessibilityLabel="Edit details" onPress={openEdit} className="p-2">
          <Ionicons name="create-outline" size={22} color="#0f766e" />
        </Pressable>
        <Pressable accessibilityLabel="Retire asset and preserve history" onPress={deleteAsset} className="p-2">
          <Ionicons name="archive-outline" size={22} color="#dc2626" />
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-12">
        {loadError ? <View className="mb-3"><Text accessibilityRole="alert" className="mb-2 text-red-700">{loadError}</Text><Button title="Refresh" variant="secondary" onPress={() => void load()} /></View> : null}
        <View className="mb-3 flex-row gap-2"><View className="flex-1"><Button title="New job" onPress={() => router.push({ pathname: "/work-orders", params: { new: "1", propertyId: asset.property_id, assetId: asset.id, ...(asset.unit_id ? { unitId: asset.unit_id } : {}) } })} /></View><View className="flex-1"><Button title="Schedule service" variant="secondary" onPress={() => router.push({ pathname: "/maintenance", params: { new: "1", propertyId: asset.property_id, assetId: asset.id, ...(asset.unit_id ? { unitId: asset.unit_id } : {}) } })} /></View></View>
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

        <Text className="mb-2 mt-4 text-lg font-semibold text-slate-900">Maintenance costs</Text><Card>{costTotals.length ? costTotals.map(t => <Row key={t.currency} label={`Recorded ${t.currency}`} value={formatCurrency(Number(t.total), t.currency)} />) : <Text className="text-slate-500">No expenses have been linked to this asset’s jobs yet.</Text>}</Card>
        <Text className="mb-2 mt-4 text-lg font-semibold text-slate-900">Upcoming service</Text>{schedules.length ? schedules.map(s => <Card key={s.id} onPress={() => router.push({ pathname: "/maintenance", params: { assetId: asset.id } })}><Text className="font-semibold text-slate-800">{s.title}</Text><Text className="mt-1 text-slate-500">{s.next_due ? formatDate(s.next_due) : "No due date set"}</Text></Card>) : <Text className="text-slate-500">No active service schedules.</Text>}
        <Text className="mb-2 mt-4 text-lg font-semibold text-slate-900">Service history</Text><Text className="mb-2 text-xs text-slate-500">Most recent 50 jobs</Text>{jobs.length ? jobs.map(j => <Card key={j.id} onPress={() => router.push(`/work-order/${j.id}`)}><View className="flex-row justify-between"><Text className="flex-1 font-semibold text-slate-800">{j.title}</Text><Badge label={j.status} /></View><Text className="mt-1 text-slate-500">{formatDate(j.completed_at || j.created_at)}</Text></Card>) : <Text className="text-slate-500">No jobs recorded for this asset.</Text>}
        {/* Printable QR tag — scanning it opens this asset in the app. */}
        <Text className="mb-2 mt-4 text-lg font-semibold text-slate-900">
          QR tag
        </Text>
        <Card>
          <View className="items-center py-2">
            {qrUrl ? <QRCode value={qrUrl} size={160} getRef={(ref) => { qrRef.current = ref; }} /> : <Text className="text-slate-600">Asset labels and sharing are currently unavailable.</Text>}
            <Text className="mt-3 text-center text-sm text-slate-500">
              Print and stick this on the asset. Scan it with the in-app
              scanner (or any phone camera) to jump straight here.
            </Text>
          </View><View className="mt-3 flex-row gap-2">{Platform.OS === "web" ? <Button title="Print QR label" variant="secondary" disabled={!qrUrl} onPress={printLabel} /> : null}<Button title="Share asset link" variant="secondary" disabled={!qrUrl} onPress={() => void shareAsset()} /></View>
        </Card>

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

      <Modal visible={editing} onRequestClose={() => !saving && setEditing(false)} animationType="slide" transparent>
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
