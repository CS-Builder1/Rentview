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
import { editedSavedChange, savedChangeLabels, savedChangeNumericFields } from "../lib/savedChangeEdit";

const labels = savedChangeLabels;
const editable = ["title", "name", "description", "tenant_name", "tenant_email", "amount", "rent_amount", "purchase_cost", "deposit_amount", "currency", "rent_currency", "purchase_currency", "due_date", "start_date", "end_date", "incurred_on", "install_date", "warranty_expiry"];
const numeric = savedChangeNumericFields;
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
    if (editing.accountId !== session!.user.id) throw new Error("This saved change belongs to a different account. Reopen Saved changes before editing.");
    const payload = editedSavedChange(editing.table, editing.payload, values);
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
      <Modal visible={editing !== null} transparent animationType="slide" onRequestClose={() => !busy && setEditing(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} className="flex-1 justify-end bg-black/40">
          <ScrollView className="max-h-[90%] rounded-t-3xl bg-slate-50" contentContainerClassName="p-5" keyboardShouldPersistTaps="handled">
            <Text className="mb-4 text-xl font-bold text-slate-900">Edit saved change</Text>
            <Text className="mb-4 text-slate-600">Changing details keeps the same record ID so retrying cannot create another copy.</Text>
            {Object.entries(values).map(([key, value]) => <Field key={key} label={labels[key]} value={value} editable={!busy} onChangeText={(text) => setValues((current) => ({ ...current, [key]: text }))} keyboardType={numeric.has(key) ? "decimal-pad" : "default"} autoCapitalize={dates.has(key) || key.includes("email") ? "none" : "sentences"} />)}
            <View className="gap-3"><Button title="Save and retry" onPress={() => void run(saveEdit)} loading={busy} /><Button title="Cancel" variant="secondary" onPress={() => setEditing(null)} disabled={busy} /></View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </Screen>
  );
}
