import { Ionicons } from "@expo/vector-icons";
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useCallback, useState } from "react";
import {
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";

import { DocumentsSection } from "../../../components/DocumentsSection";
import {
  Badge,
  Button,
  Card,
  Field,
  Loading,
  Screen,
} from "../../../components/ui";
import { pickAndUploadImage, signedUrl } from "../../../lib/attachments";
import { useAuth } from "../../../lib/auth";
import type { Tables } from "../../../lib/database.types";
import { Constants } from "../../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";

type WO = Tables<"work_orders"> & {
  properties: { name: string; currency: string } | null;
  units: { label: string } | null;
  vendors: { name: string } | null;
  assets: { name: string } | null;
};

const STATUSES = Constants.public.Enums.wo_status;
const PRIORITIES = Constants.public.Enums.wo_priority;

function notify(title: string, message: string) {
  Platform.OS === "web"
    ? window.alert(`${title}\n\n${message}`)
    : Alert.alert(title, message);
}

export default function WorkOrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();

  const [wo, setWo] = useState<WO | null>(null);
  const [parts, setParts] = useState<Tables<"work_order_parts">[]>([]);
  const [photos, setPhotos] = useState<
    { id: string; path: string; url: string | null }[]
  >([]);
  const [vendors, setVendors] = useState<Tables<"vendors">[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  // add-part modal
  const [addingPart, setAddingPart] = useState(false);
  const [partDesc, setPartDesc] = useState("");
  const [partQty, setPartQty] = useState("1");
  const [partCost, setPartCost] = useState("");

  // edit-work-order modal
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState("");
  const [eDesc, setEDesc] = useState("");
  const [ePriority, setEPriority] =
    useState<(typeof PRIORITIES)[number]>("medium");
  const [eDue, setEDue] = useState("");

  const currency = wo?.properties?.currency ?? "USD";

  const load = useCallback(async () => {
    if (!id) return;
    const [woRes, partsRes, docsRes, vendorsRes] = await Promise.all([
      supabase
        .from("work_orders")
        .select(
          "*, properties(name, currency), units(label), vendors(name), assets(name)",
        )
        .eq("id", id)
        .single(),
      supabase.from("work_order_parts").select("*").eq("work_order_id", id),
      supabase
        .from("documents")
        .select("id, storage_path")
        .eq("work_order_id", id)
        .eq("doc_type", "photo")
        .order("created_at", { ascending: false }),
      supabase.from("vendors").select("*").order("name"),
    ]);

    setWo((woRes.data as WO) ?? null);
    setParts(partsRes.data ?? []);
    setVendors(vendorsRes.data ?? []);

    const docs = docsRes.data ?? [];
    const resolved = await Promise.all(
      docs.map(async (d) => ({
        id: d.id,
        path: d.storage_path,
        url: await signedUrl(d.storage_path),
      })),
    );
    setPhotos(resolved);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function updateStatus(status: (typeof STATUSES)[number]) {
    if (!wo) return;
    setBusy(true);
    await supabase
      .from("work_orders")
      .update({
        status,
        completed_at:
          status === "completed" ? new Date().toISOString() : null,
      })
      .eq("id", wo.id);
    setBusy(false);
    load();
  }

  async function assignVendor(vendorId: string | null) {
    if (!wo) return;
    setBusy(true);
    await supabase
      .from("work_orders")
      .update({ vendor_id: vendorId })
      .eq("id", wo.id);
    setBusy(false);
    load();
  }

  async function addPart() {
    if (!partDesc.trim() || !session || !wo) return;
    setBusy(true);
    await supabase.from("work_order_parts").insert({
      owner_id: session.user.id,
      work_order_id: wo.id,
      description: partDesc.trim(),
      quantity: partQty ? Number(partQty) : 1,
      unit_cost: partCost ? Number(partCost) : null,
      cost_currency: currency,
    });
    setBusy(false);
    setAddingPart(false);
    setPartDesc("");
    setPartQty("1");
    setPartCost("");
    load();
  }

  async function removePart(partId: string) {
    await supabase.from("work_order_parts").delete().eq("id", partId);
    load();
  }

  async function addPhoto() {
    if (!session || !wo) return;
    setUploading(true);
    try {
      const uploaded = await pickAndUploadImage(
        session.user.id,
        `work_orders/${wo.id}`,
      );
      if (uploaded) {
        await supabase.from("documents").insert({
          owner_id: session.user.id,
          work_order_id: wo.id,
          property_id: wo.property_id,
          unit_id: wo.unit_id,
          name: "Photo",
          doc_type: "photo",
          storage_path: uploaded.storagePath,
          mime_type: uploaded.mimeType,
          size_bytes: uploaded.sizeBytes,
        });
        load();
      }
    } catch (e) {
      notify("Upload failed", e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  function openEdit() {
    if (!wo) return;
    setETitle(wo.title);
    setEDesc(wo.description ?? "");
    setEPriority(wo.priority);
    setEDue(wo.due_date ?? "");
    setEditing(true);
  }

  async function saveEdit() {
    if (!eTitle.trim() || !wo) return;
    setBusy(true);
    await supabase
      .from("work_orders")
      .update({
        title: eTitle.trim(),
        description: eDesc.trim() || null,
        priority: ePriority,
        due_date: eDue.trim() || null,
      })
      .eq("id", wo.id);
    setBusy(false);
    setEditing(false);
    load();
  }

  function confirmDelete() {
    const run = async () => {
      if (!wo) return;
      await supabase.from("work_orders").delete().eq("id", wo.id);
      router.back();
    };
    if (Platform.OS === "web") {
      if (window.confirm("Delete this work order? This cannot be undone.")) run();
    } else {
      Alert.alert("Delete work order", "This cannot be undone.", [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: run },
      ]);
    }
  }

  if (!wo) return <Loading />;

  const partsTotal = parts.reduce(
    (sum, p) => sum + Number(p.unit_cost ?? 0) * Number(p.quantity ?? 0),
    0,
  );

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/work-orders")
          }
          className="p-2"
        >
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text
          className="flex-1 text-xl font-bold text-slate-900"
          numberOfLines={1}
        >
          {wo.title}
        </Text>
        <Pressable onPress={openEdit} className="p-2">
          <Ionicons name="create-outline" size={22} color="#0f766e" />
        </Pressable>
        <Pressable onPress={confirmDelete} className="p-2">
          <Ionicons name="trash-outline" size={22} color="#dc2626" />
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-12">
        <Card>
          <View className="flex-row items-center justify-between">
            <Badge label={wo.priority} />
            <Text className="text-slate-500">
              {wo.properties?.name ?? "—"}
              {wo.units?.label ? ` · ${wo.units.label}` : ""}
            </Text>
          </View>
          {wo.description ? (
            <Text className="mt-3 text-slate-700">{wo.description}</Text>
          ) : null}
          {wo.asset_id && wo.assets ? (
            <Text className="mt-2 text-slate-500">Asset: {wo.assets.name}</Text>
          ) : null}
          <Text className="mt-2 text-xs text-slate-400">
            Opened {formatDate(wo.created_at)}
            {wo.completed_at
              ? ` · Completed ${formatDate(wo.completed_at)}`
              : ""}
          </Text>
        </Card>

        {/* Status */}
        <Text className="mb-2 mt-4 text-sm font-semibold uppercase text-slate-400">
          Status
        </Text>
        <View className="flex-row flex-wrap">
          {STATUSES.map((s) => (
            <Pressable
              key={s}
              disabled={busy}
              onPress={() => updateStatus(s)}
              className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                wo.status === s
                  ? "border-brand bg-brand"
                  : "border-slate-300 bg-white"
              }`}
            >
              <Text
                className={
                  wo.status === s ? "font-medium text-white" : "text-slate-700"
                }
              >
                {titleCase(s)}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Vendor */}
        <Text className="mb-2 mt-4 text-sm font-semibold uppercase text-slate-400">
          Assigned vendor
        </Text>
        <View className="flex-row flex-wrap">
          <Pressable
            disabled={busy}
            onPress={() => assignVendor(null)}
            className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
              !wo.vendor_id ? "border-brand bg-brand" : "border-slate-300 bg-white"
            }`}
          >
            <Text
              className={!wo.vendor_id ? "font-medium text-white" : "text-slate-700"}
            >
              Unassigned
            </Text>
          </Pressable>
          {vendors.map((v) => (
            <Pressable
              key={v.id}
              disabled={busy}
              onPress={() => assignVendor(v.id)}
              className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                wo.vendor_id === v.id
                  ? "border-brand bg-brand"
                  : "border-slate-300 bg-white"
              }`}
            >
              <Text
                className={
                  wo.vendor_id === v.id
                    ? "font-medium text-white"
                    : "text-slate-700"
                }
              >
                {v.name}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Parts */}
        <View className="mb-2 mt-4 flex-row items-center justify-between">
          <Text className="text-sm font-semibold uppercase text-slate-400">
            Parts used
          </Text>
          <Pressable
            onPress={() => setAddingPart(true)}
            className="flex-row items-center rounded-full bg-brand px-3 py-1.5"
          >
            <Ionicons name="add" color="#fff" size={16} />
            <Text className="ml-1 font-semibold text-white">Add</Text>
          </Pressable>
        </View>
        {parts.length === 0 ? (
          <Text className="mb-2 text-slate-400">No parts logged.</Text>
        ) : (
          <Card>
            {parts.map((p) => (
              <View
                key={p.id}
                className="flex-row items-center justify-between border-b border-slate-100 py-2"
              >
                <Text className="flex-1 text-slate-700">
                  {Number(p.quantity)} × {p.description}
                </Text>
                <Text className="mr-3 text-slate-600">
                  {p.unit_cost
                    ? formatCurrency(
                        Number(p.unit_cost) * Number(p.quantity),
                        p.cost_currency ?? currency,
                      )
                    : "—"}
                </Text>
                <Pressable onPress={() => removePart(p.id)}>
                  <Ionicons name="close-circle" size={20} color="#cbd5e1" />
                </Pressable>
              </View>
            ))}
            <View className="flex-row justify-between pt-2">
              <Text className="font-semibold text-slate-800">Parts total</Text>
              <Text className="font-semibold text-slate-900">
                {formatCurrency(partsTotal, currency)}
              </Text>
            </View>
          </Card>
        )}

        {/* Photos */}
        <View className="mb-2 mt-4 flex-row items-center justify-between">
          <Text className="text-sm font-semibold uppercase text-slate-400">
            Photos
          </Text>
          <Pressable
            disabled={uploading}
            onPress={addPhoto}
            className="flex-row items-center rounded-full bg-brand px-3 py-1.5"
          >
            <Ionicons name="camera" color="#fff" size={16} />
            <Text className="ml-1 font-semibold text-white">
              {uploading ? "Uploading…" : "Add"}
            </Text>
          </Pressable>
        </View>
        {photos.length === 0 ? (
          <Text className="text-slate-400">No photos yet.</Text>
        ) : (
          <View className="flex-row flex-wrap">
            {photos.map((p) =>
              p.url ? (
                <Image
                  key={p.id}
                  source={{ uri: p.url }}
                  className="mb-2 mr-2 h-24 w-24 rounded-xl"
                />
              ) : null,
            )}
          </View>
        )}

        {/* Documents (invoices, receipts, quotes) — photos shown above */}
        <DocumentsSection
          scope={{
            kind: "workOrder",
            workOrderId: wo.id,
            propertyId: wo.property_id,
            unitId: wo.unit_id,
          }}
          defaultDocType="invoice"
        />
      </ScrollView>

      <Modal visible={editing} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[88%] rounded-t-3xl bg-slate-50"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900">
              Edit work order
            </Text>
            <Field label="Title" value={eTitle} onChangeText={setETitle} />
            <Field
              label="Description"
              value={eDesc}
              onChangeText={setEDesc}
              placeholder="Details, location, what's needed…"
              multiline
            />
            <Text className="mb-1 text-sm font-medium text-slate-600">
              Priority
            </Text>
            <View className="mb-3 flex-row flex-wrap">
              {PRIORITIES.map((p) => (
                <Pressable
                  key={p}
                  onPress={() => setEPriority(p)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    ePriority === p
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  <Text
                    className={
                      ePriority === p ? "font-medium text-white" : "text-slate-700"
                    }
                  >
                    {titleCase(p)}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Field
              label="Due date (YYYY-MM-DD, optional)"
              value={eDue}
              onChangeText={setEDue}
              placeholder="2026-08-01"
              autoCapitalize="none"
            />
            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <Button
                  title="Cancel"
                  variant="secondary"
                  onPress={() => setEditing(false)}
                />
              </View>
              <View className="flex-1">
                <Button title="Save" onPress={saveEdit} loading={busy} />
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>

      <Modal visible={addingPart} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <View className="rounded-t-3xl bg-slate-50 p-5">
            <Text className="mb-4 text-xl font-bold text-slate-900">Add part</Text>
            <Field
              label="Description"
              value={partDesc}
              onChangeText={setPartDesc}
              placeholder="e.g. Tap washer kit"
            />
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Field
                  label="Quantity"
                  value={partQty}
                  onChangeText={setPartQty}
                  keyboardType="decimal-pad"
                />
              </View>
              <View className="flex-1">
                <Field
                  label={`Unit cost (${currency})`}
                  value={partCost}
                  onChangeText={setPartCost}
                  placeholder="0.00"
                  keyboardType="decimal-pad"
                />
              </View>
            </View>
            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <Button
                  title="Cancel"
                  variant="secondary"
                  onPress={() => setAddingPart(false)}
                />
              </View>
              <View className="flex-1">
                <Button title="Save" onPress={addPart} loading={busy} />
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
