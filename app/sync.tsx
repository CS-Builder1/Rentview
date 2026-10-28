import { Ionicons } from "@expo/vector-icons";
import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Card, Field, Loading, Screen } from "../components/ui";
import { useAuth } from "../lib/auth";
import { readCache } from "../lib/cache";
import { confirmAction } from "../lib/confirm";
import { useOffline } from "../lib/offline";
import type { QueuedInsert, QueuedOp } from "../lib/offlineStore";

const labels: Record<string, string> = {
  assets: "Asset", expenses: "Expense", leases: "Lease", work_orders: "Work order",
  title: "Title", name: "Name", description: "Description", tenant_name: "Tenant name", tenant_email: "Tenant email",
  amount: "Amount", rent_amount: "Rent amount", purchase_cost: "Purchase cost", currency: "Currency", rent_currency: "Rent currency",
  purchase_currency: "Purchase currency", due_date: "Due date", start_date: "Start date", end_date: "End date",
  incurred_on: "Expense date", install_date: "Installed date", warranty_expiry: "Warranty expiry",
};
const editable = ["title", "name", "description", "tenant_name", "tenant_email", "amount", "rent_amount", "purchase_cost", "currency", "rent_currency", "purchase_currency", "due_date", "start_date", "end_date", "incurred_on", "install_date", "warranty_expiry"];
const numeric = new Set(["amount", "rent_amount", "purchase_cost"]);
const dates = new Set(["due_date", "start_date", "end_date", "incurred_on", "install_date", "warranty_expiry"]);
function notify(message: string) { Platform.OS === "web" ? window.alert(message) : Alert.alert("Saved changes", message); }
function summary(operation: QueuedOp): string {
  if (operation.kind === "photo") return "Photo";
  return String(operation.payload.title ?? operation.payload.name ?? operation.payload.tenant_name ?? operation.payload.description ?? labels[operation.table]);
}

export default function SavedChanges() {
  const { session, initializing } = useAuth();
  const router = useRouter();
  const { operations, syncing, online, storageError, hasQuarantinedChanges, sync, refresh, retryOperation, discardOperation, editOperation } = useOffline();
  const [notices, setNotices] = useState(readCache.getNotices);
  const [editing, setEditing] = useState<QueuedInsert | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
  useEffect(() => readCache.subscribe(() => setNotices(readCache.getNotices())), []);
  if (initializing) return <Loading />;
  if (!session) return <Redirect href="/(auth)/login" />;

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    try { await work(); } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  function startEdit(operation: QueuedInsert) {
    setValues(Object.fromEntries(editable.filter((key) => key in operation.payload).map((key) => [key, String(operation.payload[key] ?? "")])));
    setEditing(operation);
  }
  async function saveEdit() {
    if (!editing) return;
    const payload = { ...editing.payload };
    for (const [key, value] of Object.entries(values)) {
      const trimmed = value.trim();
      if (numeric.has(key)) {
        const number = Number(trimmed);
        if (!trimmed || !Number.isFinite(number) || number < 0) throw new Error(`Enter a valid ${labels[key].toLowerCase()}.`);
        payload[key] = number;
      } else if (dates.has(key)) {
        const date = new Date(`${trimmed}T00:00:00Z`);
        if (trimmed && (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== trimmed)) {
          throw new Error(`Enter ${labels[key].toLowerCase()} as YYYY-MM-DD.`);
        }
        payload[key] = trimmed || null;
      } else if (key.endsWith("currency") || key === "currency") {
        if (!/^[A-Za-z]{3}$/.test(trimmed)) throw new Error("Enter a three-letter currency code.");
        payload[key] = trimmed.toUpperCase();
      } else payload[key] = trimmed || null;
    }
    await editOperation(editing.id, payload);
    setEditing(null);
  }

  return (
    <Screen>
      <View className="flex-row items-center px-4 py-3">
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.canGoBack() ? router.back() : router.replace("/")} className="p-2">
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text className="ml-2 flex-1 text-xl font-bold text-slate-900">Saved changes</Text>
      </View>
      <ScrollView contentContainerClassName="px-5 pb-12">
        <Text className="mb-4 text-slate-600">These changes are saved on this device for your account. Failed changes stay here until you correct, retry or discard them.</Text>
        {storageError ? <Card><Text accessibilityRole="alert" className="text-red-700">{storageError}</Text><Text className="mt-2 text-slate-600">Do not clear app storage while recovering unsynchronized work.</Text></Card> : null}
        {hasQuarantinedChanges ? <Card><Text className="text-amber-800">Some older saved changes could not be assigned safely to an account. The original data is preserved on this device. Contact support before clearing storage.</Text></Card> : null}
        {operations.length ? <View className="mb-4"><Button title={syncing ? "Syncing…" : online ? "Sync pending changes" : "Waiting for a connection"} onPress={() => void sync()} disabled={!online || syncing} /></View> : !storageError ? <Card><Text className="text-slate-700">No changes waiting to sync.</Text></Card> : null}
        {operations.map((operation) => (
          <Card key={operation.id}>
            <Text className="text-xs font-semibold uppercase text-slate-500">{operation.kind === "photo" ? "Photo" : labels[operation.table]} · {operation.status === "failed" ? "Needs attention" : "Waiting to sync"}</Text>
            <Text className="mt-1 text-lg font-semibold text-slate-900">{summary(operation)}</Text>
            <Text className="mt-1 text-xs text-slate-500">Saved {new Date(operation.createdAt).toLocaleString()}</Text>
            {operation.error ? <Text accessibilityRole="alert" className="mt-3 text-sm text-red-700">{operation.error}</Text> : null}
            {operation.attempts ? <Text className="mt-2 text-xs text-slate-500">{operation.attempts} sync attempt{operation.attempts === 1 ? "" : "s"}. Check existing records if a conflict is reported.</Text> : null}
            <View className="mt-4 gap-2">
              <Button title="Retry" onPress={() => void run(() => retryOperation(operation.id))} disabled={busy || syncing || !online} />
              {operation.kind === "insert" ? <Button title="Edit details" variant="secondary" onPress={() => startEdit(operation)} disabled={busy || syncing} /> : null}
              <Button title="Discard saved change" variant="danger" disabled={busy || syncing} onPress={() => confirmAction("Discard saved change", "This permanently removes the change from this device. Check whether it already exists in your records before discarding it.", () => void run(() => discardOperation(operation.id)), "Discard")} />
            </View>
          </Card>
        ))}
        {notices.length ? <>
          <Text className="mb-2 mt-5 text-lg font-semibold text-slate-900">Information needing refresh</Text>
          {notices.map((notice) => <Card key={notice.key}>
            <Text className="font-semibold capitalize text-slate-800">{notice.key.split(":")[0].replace(/[_-]/g, " ")}</Text>
            <Text className="mt-1 text-slate-600">{notice.message}</Text>
            {notice.stale && notice.updatedAt ? <Text className="mt-2 text-xs text-slate-500">Showing information saved {new Date(notice.updatedAt).toLocaleString()}. Return to that screen to refresh.</Text> : null}
          </Card>)}
        </> : null}
      </ScrollView>
      <Modal visible={editing !== null} transparent animationType="slide" onRequestClose={() => setEditing(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} className="flex-1 justify-end bg-black/40">
          <ScrollView className="max-h-[90%] rounded-t-3xl bg-slate-50" contentContainerClassName="p-5" keyboardShouldPersistTaps="handled">
            <Text className="mb-4 text-xl font-bold text-slate-900">Edit saved change</Text>
            <Text className="mb-4 text-slate-600">Changing details keeps the same record ID so retrying cannot create another copy.</Text>
            {Object.entries(values).map(([key, value]) => <Field key={key} label={labels[key]} value={value} onChangeText={(text) => setValues((current) => ({ ...current, [key]: text }))} keyboardType={numeric.has(key) ? "decimal-pad" : "default"} autoCapitalize={dates.has(key) || key.includes("email") ? "none" : "sentences"} />)}
            <View className="gap-3"><Button title="Save and retry" onPress={() => void run(saveEdit)} loading={busy} /><Button title="Cancel" variant="secondary" onPress={() => setEditing(null)} disabled={busy} /></View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </Screen>
  );
}
