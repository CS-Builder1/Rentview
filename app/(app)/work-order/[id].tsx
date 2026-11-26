import { Ionicons } from "@expo/vector-icons";
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  Alert,
  Image,
  Linking,
  Share,
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
  EmptyState,
  Loading,
  Screen,
} from "../../../components/ui";
import { pickImageForUpload, signedUrl } from "../../../lib/attachments";
import { useAuth } from "../../../lib/auth";
import { cachedSelectResult } from "../../../lib/cache";
import { useOffline } from "../../../lib/offline";
import type { Tables } from "../../../lib/database.types";
import { Constants } from "../../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";
import { operationError } from "../../../lib/operationsQuery";
import { newRecordId } from "../../../lib/id";
import { localTimeZone, partTotalsByCurrency, positiveNumber, validCalendarDate } from "../../../lib/maintenance";

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
  const { submitPhoto } = useOffline();

  const [wo, setWo] = useState<WO | null>(null);
  const [parts, setParts] = useState<Tables<"work_order_parts">[]>([]);
  const [photos, setPhotos] = useState<
    { id: string; path: string; url: string | null }[]
  >([]);
  const [vendors, setVendors] = useState<Tables<"vendors">[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false), [loadError, setLoadError] = useState<string | null>(null);
  const [stock, setStock] = useState<Tables<"inventory_items">[]>([]);
  const [inventoryId, setInventoryId] = useState<string | null>(null);
  const partOperation = useRef<{ fingerprint: string; id: string } | null>(null);
  const [useExistingExpenses, setUseExistingExpenses] = useState(false);
  const [completing, setCompleting] = useState(false), [laborAmount, setLaborAmount] = useState("0"), [completionSummary, setCompletionSummary] = useState("");
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [linkedExpenses, setLinkedExpenses] = useState<Tables<"expenses">[]>([]);
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
    const [woResult, partsResult, docsResult, vendorsResult, stockResult, expensesResult] = await Promise.all([
      cachedSelectResult<WO>(
        `wo:${id}`,
        supabase
          .from("work_orders")
          .select(
            "*, properties!work_orders_property_id_owner_fk(name, currency), units!work_orders_unit_property_owner_fk(label), vendors!work_orders_vendor_id_owner_fk(name), assets!work_orders_asset_property_owner_fk(name)",
          )
          .eq("id", id)
          .single(),
      ),
      cachedSelectResult<Tables<"work_order_parts">[]>(
        `parts:wo:${id}`,
        supabase.from("work_order_parts").select("*").eq("work_order_id", id).is("removed_at", null),
      ),
      cachedSelectResult<{ id: string; storage_path: string }[]>(
        `photos:wo:${id}`,
        supabase
          .from("documents")
          .select("id, storage_path")
          .eq("work_order_id", id)
          .eq("doc_type", "photo")
          .order("created_at", { ascending: false }),
      ),
      cachedSelectResult<Tables<"vendors">[]>(
        "vendors",
        supabase.from("vendors").select("*").order("name"),
      ),
      cachedSelectResult<Tables<"inventory_items">[]>("inventory", supabase.from("inventory_items").select("*").order("name")),
      cachedSelectResult<Tables<"expenses">[]>(`expenses:wo:${id}`, supabase.from("expenses").select("*").eq("work_order_id", id).order("incurred_on", { ascending: false })),
    ]);

    setWo(woResult.data ?? null);
    setParts(partsResult.data ?? []);
    setVendors(vendorsResult.data ?? []);
    setStock(stockResult.data ?? []);
    setLinkedExpenses(expensesResult.data ?? []);
    setLoadError(woResult.error || partsResult.error || docsResult.error || expensesResult.error || stockResult.error || vendorsResult.error);
    setLoaded(true);

    const resolved = await Promise.all(
      (docsResult.data ?? []).map(async (d) => ({
        id: d.id,
        path: d.storage_path,
        url: await signedUrl(d.storage_path).catch(() => null),
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
    if (!wo || busy) return;
    if (status === "completed") { setUseExistingExpenses(linkedExpenses.length > 0); setLaborAmount("0"); setCompleting(true); return; }
    setBusy(true);
    try {
      const { data, error } = await supabase.from("work_orders").update({ status, completed_at: null }).eq("id", wo.id).select("id").single();
      if (error || !data) throw error || new Error("This work order is no longer available.");
      await load();
    } catch (e) { notify("Could not update", operationError(e)); }
    finally { setBusy(false); }
  }
  async function assignVendor(vendorId: string | null) {
    if (!wo || busy) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.from("work_orders").update({ vendor_id: vendorId }).eq("id", wo.id).select("id").single();
      if (error || !data) throw error || new Error("This work order is no longer available.");
      await load();
    } catch (e) { notify("Could not assign vendor", operationError(e)); }
    finally { setBusy(false); }
  }
  async function addPart() {
    if (!session || !wo || busy) return;
    try {
      if (!partDesc.trim() && !inventoryId) throw new Error("Describe the part or select a stock item.");
      const quantity = positiveNumber(partQty, "Quantity");
      const unitCost = partCost.trim() ? positiveNumber(partCost, "Unit cost", true) : null;
      const fingerprint = JSON.stringify([wo.id, inventoryId, partDesc.trim(), quantity, unitCost, currency]);
      if (partOperation.current?.fingerprint !== fingerprint) partOperation.current = { fingerprint, id: newRecordId() };
      setBusy(true);
      const { error } = await supabase.rpc("add_work_order_part", { p_work_order_id: wo.id, p_inventory_item_id: inventoryId, p_description: partDesc.trim() || null, p_quantity: quantity, p_unit_cost: unitCost, p_currency: currency, p_operation_id: partOperation.current.id });
      if (error) throw error;
      setAddingPart(false); setPartDesc(""); setPartQty("1"); setPartCost(""); setInventoryId(null); partOperation.current = null;
      await load();
    } catch (e) { notify("Could not add part", operationError(e)); }
    finally { setBusy(false); }
  }
  async function removePart(partId: string) {
    if (busy) return;
    setBusy(true);
    try { const { error } = await supabase.rpc("remove_work_order_part", { p_part_id: partId }); if (error) throw error; await load(); }
    catch (e) { notify("Could not remove part", operationError(e)); }
    finally { setBusy(false); }
  }
  async function completeWork() {
    if (!wo || busy) return;
    try {
      const labor = positiveNumber(laborAmount, "Labor cost", true);
      if ([...partTotalsByCurrency(parts, currency).keys()].some(c => c !== currency)) throw new Error(`Parts use different currencies. Correct them to ${currency} before posting this job cost.`);
      setBusy(true);
      const { error } = await supabase.rpc("complete_work_order", { p_work_order_id: wo.id, p_labor_amount: labor, p_currency: currency, p_summary: completionSummary.trim() || null, p_use_existing_expenses: useExistingExpenses, p_time_zone: localTimeZone() });
      if (error) throw error;
      setCompleting(false); await load();
    } catch (e) { notify("Could not complete job", operationError(e)); }
    finally { setBusy(false); }
  }
  async function shareJob() {
    if (!wo) return;
    try { await Share.share({ title: wo.title, message: [wo.title, [wo.properties?.name, wo.units?.label || "Shared / common"].filter(Boolean).join(" · "), wo.description, wo.due_date ? `Due: ${formatDate(wo.due_date)}` : "", "Please contact the property owner to arrange access."].filter(Boolean).join("\n\n") }); }
    catch (e) { notify("Could not share", operationError(e)); }
  }

  async function addPhoto() {
    if (!session || !wo) return;
    try {
      const picked = await pickImageForUpload();
      if (!picked) return;
      setUploading(true);
      const storagePath = `${session.user.id}/work_orders/${wo.id}/${Date.now()}.${picked.ext}`;
      const result = await submitPhoto({
        base64: picked.base64,
        contentType: picked.contentType,
        storagePath,
        doc: {
          owner_id: session.user.id,
          work_order_id: wo.id,
          property_id: wo.property_id,
          unit_id: wo.unit_id,
          name: "Photo",
          doc_type: "photo",
        },
      });
      if (result === "queued") {
        notify(
          "Saved offline",
          "This photo will upload automatically when you're back online.",
        );
      } else {
        load();
      }
    } catch (e) {
      notify("Upload failed", operationError(e));
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
    if (!wo || busy) return;
    if (!eTitle.trim()) { notify("Missing title", "Enter a title for this job."); return; }
    if (eDue.trim() && !validCalendarDate(eDue.trim())) { notify("Invalid date", "Use a valid date in YYYY-MM-DD format."); return; }
    setBusy(true);
    try {
      const { data, error } = await supabase.from("work_orders").update({ title: eTitle.trim(), description: eDesc.trim() || null, priority: ePriority, due_date: eDue.trim() || null }).eq("id", wo.id).select("id").single();
      if (error || !data) throw error || new Error("This work order is no longer available.");
      setEditing(false); await load();
    } catch (e) { notify("Could not save", operationError(e)); }
    finally { setBusy(false); }
  }

  function confirmDelete() {
    const run = async () => {
      if (!wo) return;
      if (wo.status === "completed") { notify("Keep completed history", "Completed jobs retain their costs and service history. Record corrections as separate expenses."); return; }
      try {
        const { error } = await supabase.from("work_orders").update({ status: "cancelled" }).eq("id", wo.id).select("id").single();
        if (error) throw error;
        router.replace("/work-orders");
      } catch (e) { notify("Could not cancel job", operationError(e)); }
    };
    if (Platform.OS === "web") {
      if (window.confirm("Cancel this job? Its history and used parts are retained. Remove unused parts first to return them to stock.")) run();
    } else {
      Alert.alert("Cancel job", "Its history and used parts are retained. Remove unused parts first to return them to stock.", [
        { text: "Cancel", style: "cancel" },
        { text: "Cancel job", style: "destructive", onPress: run },
      ]);
    }
  }

  if (!wo) return loaded ? <Screen><EmptyState title="Work order unavailable" subtitle={loadError || "It may have been removed or your access may have changed."} /><Button title="Retry" variant="secondary" onPress={() => void load()} /><Button title="Back to work" onPress={() => router.replace("/work-orders")} /></Screen> : <Loading />;

  const partsTotals = partTotalsByCurrency(parts, currency);
  const vendor = vendors.find(v => v.id === wo.vendor_id);
  const posted = wo.status === "completed";

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
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
        <Pressable accessibilityRole="button" accessibilityLabel="Edit details" onPress={openEdit} className="p-2">
          <Ionicons name="create-outline" size={22} color="#0f766e" />
        </Pressable>
        <Pressable accessibilityLabel="Cancel job and preserve history" onPress={confirmDelete} className="p-2">
          <Ionicons name="archive-outline" size={22} color="#dc2626" />
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-12">
        {loadError ? <View className="mb-3"><Text accessibilityRole="alert" className="mb-2 text-red-700">{loadError}</Text><Button title="Refresh" variant="secondary" onPress={() => void load()} /></View> : null}
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
              disabled={busy || (posted && s !== "completed")}
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

        {posted ? <Text className="mt-2 text-slate-500">Completed jobs retain their posted costs. Record any correction as a separate expense.</Text> : null}
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

        {vendor ? <Card><Text className="font-semibold text-slate-800">Contact {vendor.name}</Text><Text className="my-2 text-slate-500">Assignment does not notify the vendor. Share this job or contact them to arrange a visit.</Text><View className="flex-row gap-2">{vendor.phone ? <Button title="Call" variant="secondary" onPress={() => { void Linking.openURL(`tel:${vendor.phone!.replace(/[^+0-9]/g, "")}`).catch(() => notify("Could not call", "Use the phone number in Vendors.")); }} /> : null}{vendor.email ? <Button title="Email" variant="secondary" onPress={() => { void Linking.openURL(`mailto:${encodeURIComponent(vendor.email!)}`).catch(() => notify("Could not email", "Use the email address in Vendors.")); }} /> : null}<Button title="Share job details" variant="secondary" onPress={() => void shareJob()} /></View></Card> : <Button title="Share job details" variant="secondary" onPress={() => void shareJob()} />}
        {/* Parts */}
        <View className="mb-2 mt-4 flex-row items-center justify-between">
          <Text className="text-sm font-semibold uppercase text-slate-400">
            Parts used
          </Text>
          <Pressable
            disabled={posted}
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
                <Pressable accessibilityLabel={`Remove ${p.description || "part"} and return stock`} disabled={posted || busy} onPress={() => void removePart(p.id)}>
                  <Ionicons name="close-circle" size={20} color="#cbd5e1" />
                </Pressable>
              </View>
            ))}
            <View className="flex-row justify-between pt-2">
              <Text className="font-semibold text-slate-800">Parts total</Text>
              <Text className="font-semibold text-slate-900">
                {[...partsTotals.entries()].map(([c, amount]) => formatCurrency(amount, c)).join(" + ")}
              </Text>
            </View>
          </Card>
        )}

        {linkedExpenses.length ? <Card><Text className="mb-2 font-semibold text-slate-800">Recorded job expenses</Text>{linkedExpenses.map(e => <Text key={e.id} className="mb-1 text-slate-600">{formatDate(e.incurred_on)} · {formatCurrency(e.amount, e.currency)} · {e.description || titleCase(e.category)}</Text>)}</Card> : null}
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
                <Pressable key={p.id} accessibilityRole="button" accessibilityLabel="Open job photo" onPress={() => setPhotoPreview(p.url)}><Image source={{ uri: p.url }} className="mb-2 mr-2 h-24 w-24 rounded-xl" /></Pressable>
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

      <Modal visible={editing} onRequestClose={() => !busy && setEditing(false)} animationType="slide" transparent>
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

      <Modal visible={addingPart} onRequestClose={() => !busy && setAddingPart(false)} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <View className="rounded-t-3xl bg-slate-50 p-5">
            <Text className="mb-4 text-xl font-bold text-slate-900">Add part</Text>
            <Text className="mb-2 text-slate-600">Choose stock to deduct it automatically, or describe an externally purchased part.</Text><ScrollView horizontal className="mb-3"><View className="flex-row"><Button title="External part" variant={inventoryId ? "secondary" : "primary"} onPress={() => setInventoryId(null)} />{stock.filter(i => (!i.property_id || i.property_id === wo.property_id) && (!i.unit_id || i.unit_id === wo.unit_id)).map(i => <View key={i.id} className="ml-2"><Button title={`${i.name} (${i.quantity} available)`} variant={inventoryId === i.id ? "primary" : "secondary"} onPress={() => { setInventoryId(i.id); setPartDesc(i.name); setPartCost(i.unit_cost == null ? "" : String(i.unit_cost)); }} /></View>)}</View></ScrollView>
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
                  label={`Unit cost (${stock.find(i => i.id === inventoryId)?.cost_currency || currency})`}
                  value={partCost}
                  onChangeText={setPartCost}
                  editable={!inventoryId}
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
      <Modal visible={completing} onRequestClose={() => !busy && setCompleting(false)} animationType="slide" transparent><View className="flex-1 justify-end bg-black/40"><ScrollView className="max-h-[85%] rounded-t-3xl bg-slate-50" contentContainerClassName="p-5"><Text className="mb-3 text-xl font-bold text-slate-900">Complete repair</Text><Text className="mb-3 text-slate-600">Record the work and labor. Parts and labor become one linked maintenance expense; retries do not post it twice. Existing separately logged invoices should not be entered here again.</Text>{linkedExpenses.length ? <View className="mb-3"><Button title={useExistingExpenses ? "Using existing linked invoices" : "Use existing linked invoices"} variant={useExistingExpenses ? "primary" : "secondary"} onPress={() => { setUseExistingExpenses(true); setLaborAmount("0"); }} /><Text className="mt-2 text-slate-600">The existing linked invoices are the complete job cost, including any parts. They will not be posted again. Add any missing invoice under Expenses before completing.</Text></View> : null}<Field label="What was done?" value={completionSummary} onChangeText={setCompletionSummary} multiline /><Field label={`Labor cost (${currency})`} value={laborAmount} onChangeText={setLaborAmount} editable={!useExistingExpenses} keyboardType="decimal-pad" /><Text className="mb-3 text-slate-600">Parts: {[...partsTotals.entries()].map(([c, value]) => formatCurrency(value, c)).join(" + ") || formatCurrency(0, currency)}</Text><View className="flex-row gap-3"><View className="flex-1"><Button title="Cancel" variant="secondary" disabled={busy} onPress={() => setCompleting(false)} /></View><View className="flex-1"><Button title="Complete and record cost" loading={busy} onPress={() => void completeWork()} /></View></View></ScrollView></View></Modal>
      <Modal visible={!!photoPreview} onRequestClose={() => setPhotoPreview(null)} transparent><View className="flex-1 bg-black p-5"><Button title="Close photo" onPress={() => setPhotoPreview(null)} />{photoPreview ? <Image source={{ uri: photoPreview }} style={{ flex: 1 }} resizeMode="contain" accessibilityLabel="Job photo" /> : null}</View></Modal>
    </Screen>
  );
}
