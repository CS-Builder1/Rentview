import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { Button, Card, EmptyState, Field, Loading, Screen } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { cachedSelectResult } from "../../lib/cache";
import type { Tables } from "../../lib/database.types";
import { Constants } from "../../lib/database.types";
import { notify } from "../../lib/feedback";
import { formatDate, titleCase } from "../../lib/format";
import { localToday, nextMaintenanceDate, validCalendarDate } from "../../lib/maintenance";
import { supabase } from "../../lib/supabase";
import { operationError, readAllPages } from "../../lib/operationsQuery";

type Schedule = Tables<"maintenance_schedules"> & { properties: { name: string } | null; cadence?: string };
type Completion = { id: string; completed_on: string; notes: string | null; next_due: string | null };
const FREQS = Constants.public.Enums.schedule_freq;
export default function Maintenance() {
  const router = useRouter();
  const params = useLocalSearchParams<{ filter?: string; propertyId?: string; assetId?: string; unitId?: string; new?: string }>();
  const { session } = useAuth();
  const [schedules, setSchedules] = useState<Schedule[] | null>(null), [properties, setProperties] = useState<Tables<"properties">[]>([]);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(params.new === "1"), [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState(""), [propertyId, setPropertyId] = useState<string | null>(params.propertyId ?? null);
  const [frequency, setFrequency] = useState<typeof FREQS[number]>("quarterly"), [intervalDays, setIntervalDays] = useState("");
  const [scopeLocked, setScopeLocked] = useState(!!(params.assetId || params.unitId));
  const [nextDue, setNextDue] = useState(""), [cadence, setCadence] = useState("completion");
  const [search, setSearch] = useState(""), [showPaused, setShowPaused] = useState(false);
  const [history, setHistory] = useState<Completion[] | null>(null), [historyTitle, setHistoryTitle] = useState("");
  const [completing, setCompleting] = useState<Schedule | null>(null), [completedOn, setCompletedOn] = useState(localToday()), [notes, setNotes] = useState("");
  const load = useCallback(async () => {
    const [s, p] = await Promise.all([
      cachedSelectResult<Schedule[]>("schedules", readAllPages<Schedule>((from, to) => supabase.from("maintenance_schedules").select("*, properties!maintenance_schedules_property_id_owner_fk(name)", { count: "exact" }).order("next_due", { ascending: true, nullsFirst: false }).order("id").range(from, to))),
      cachedSelectResult<Tables<"properties">[]>("properties_min", supabase.from("properties").select("*").order("name")),
    ]);
    setSchedules(s.data ?? []); setProperties(p.data ?? []); setError(s.error || p.error);
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  function resetForm() { setScopeLocked(!!(params.assetId || params.unitId)); setTitle(""); setPropertyId(params.propertyId ?? null); setFrequency("quarterly"); setIntervalDays(""); setNextDue(""); setCadence("completion"); setEditingId(null); }
  function edit(s: Schedule) { setScopeLocked(!!(s.asset_id || s.unit_id)); setEditingId(s.id); setTitle(s.title); setPropertyId(s.property_id); setFrequency(s.frequency); setIntervalDays(s.interval_days == null ? "" : String(s.interval_days)); setNextDue(s.next_due ?? ""); setCadence(s.cadence ?? "completion"); setAdding(true); }
  async function save() {
    if (!session || busy) return;
    try {
      if (!title.trim()) throw new Error("Enter a schedule title.");
      if (nextDue && !validCalendarDate(nextDue)) throw new Error("Choose a valid date in YYYY-MM-DD format.");
      nextMaintenanceDate(nextDue || localToday(), frequency, frequency === "custom" ? Number(intervalDays) : null);
      setBusy(true);
      const payload = { title: title.trim(), property_id: propertyId, frequency, interval_days: frequency === "custom" ? Number(intervalDays) : null, next_due: nextDue || null, cadence };
      const { error: e } = editingId ? await supabase.from("maintenance_schedules").update(payload).eq("id", editingId).select("id").single() : await supabase.from("maintenance_schedules").insert({ ...payload, owner_id: session.user.id, asset_id: params.assetId ?? null, unit_id: params.unitId ?? null }).select("id").single();
      if (e) throw e;
      setAdding(false); resetForm(); await load();
    } catch (e) { notify("Could not save schedule", operationError(e)); }
    finally { setBusy(false); }
  }
  async function toggle(s: Schedule) {
    if (busy) return;
    setBusy(true);
    try { const { error: e } = await supabase.from("maintenance_schedules").update({ is_active: !s.is_active }).eq("id", s.id).select("id").single(); if (e) throw e; await load(); }
    catch (e) { notify("Could not update schedule", operationError(e)); }
    finally { setBusy(false); }
  }
  async function markDone() {
    if (!completing || busy) return;
    if (!validCalendarDate(completedOn) || completedOn > localToday()) { notify("Invalid completion date", "Choose today or a past date in YYYY-MM-DD format."); return; }
    setBusy(true);
    try { const { error: e } = await supabase.rpc("complete_maintenance_schedule", { p_schedule_id: completing.id, p_completed_on: completedOn, p_notes: notes.trim() || null }); if (e) throw e; setCompleting(null); setNotes(""); await load(); }
    catch (e) { notify("Could not record maintenance", operationError(e)); }
    finally { setBusy(false); }
  }
  async function showHistory(s: Schedule) {
    setHistoryTitle(s.title);
    const { data, error: e } = await supabase.from("maintenance_completions").select("id, completed_on, notes, next_due").eq("schedule_id", s.id).order("completed_on", { ascending: false }).limit(50);
    if (e) { notify("Could not load history", e.message); return; }
    setHistory(data ?? []);
  }
  const chip = (label: string, selected: boolean, action: () => void) => <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected }} onPress={action} className={`mb-2 mr-2 rounded-full border px-3 py-2 ${selected ? "border-brand bg-brand" : "border-slate-300 bg-white"}`}><Text className={selected ? "font-medium text-white" : "text-slate-700"}>{label}</Text></Pressable>;
  if (!schedules) return <Loading />;
  const visible = schedules.filter(s => (showPaused || s.is_active) && (!params.propertyId || s.property_id === params.propertyId) && (!params.assetId || s.asset_id === params.assetId) && (params.filter !== "due" || (!!s.next_due && s.next_due <= localToday())) && `${s.title} ${s.properties?.name ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  return <Screen><Stack.Screen options={{ headerShown: false }} /><View className="flex-row items-center px-4 pb-2 pt-2"><Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.canGoBack() ? router.back() : router.replace("/work-orders")} className="p-2"><Ionicons name="chevron-back" size={24} color="#0f766e" /></Pressable><Text className="flex-1 text-xl font-bold text-slate-900">Preventive maintenance</Text><Button title="Add" onPress={() => { resetForm(); setAdding(true); }} /></View><ScrollView contentContainerClassName="px-5 pb-10"><Field label="Search schedules" value={search} onChangeText={setSearch} /><View className="flex-row flex-wrap">{chip("Active", !showPaused, () => setShowPaused(false))}{chip("Include paused", showPaused, () => setShowPaused(true))}{params.filter === "due" ? <Button title="Show upcoming too" variant="secondary" onPress={() => router.setParams({ filter: "all" })} /> : null}</View>{error ? <View className="mb-3"><Text accessibilityRole="alert" className="mb-2 text-red-700">{error}</Text><Button title="Retry" variant="secondary" onPress={() => void load()} /></View> : null}
    {!visible.length && !error ? <EmptyState title="No schedules match" subtitle="Add recurring inspections, services and checks. Completion history stays with each schedule." /> : visible.map(s => <Card key={s.id}><View className="flex-row items-center justify-between"><Text className="flex-1 font-semibold text-slate-900">{s.title}</Text><Text className={s.is_active && s.next_due && s.next_due <= localToday() ? "text-amber-700" : "text-slate-500"}>{!s.is_active ? "Paused" : s.next_due && s.next_due <= localToday() ? "Due" : "Scheduled"}</Text></View><Text className="mt-1 text-slate-500">{titleCase(s.frequency)}{s.properties?.name ? ` · ${s.properties.name}` : ""} · {s.cadence === "scheduled" ? "Fixed cadence" : "From completion"}</Text><Text className="my-2 text-slate-500">{s.next_due ? `Next: ${formatDate(s.next_due)}` : "No date set"}{s.last_done ? ` · Last: ${formatDate(s.last_done)}` : ""}</Text><View className="flex-row flex-wrap gap-2"><Button title="Mark done" disabled={busy || !s.is_active} onPress={() => { setCompletedOn(localToday()); setNotes(""); setCompleting(s); }} /><Button title="Edit" variant="secondary" onPress={() => edit(s)} /><Button title={s.is_active ? "Pause" : "Resume"} variant="secondary" disabled={busy} onPress={() => void toggle(s)} /><Button title="History" variant="secondary" onPress={() => void showHistory(s)} />{s.property_id ? <Button title="Create job" variant="secondary" onPress={() => router.push({ pathname: "/work-orders", params: { new: "1", propertyId: s.property_id!, ...(s.unit_id ? { unitId: s.unit_id } : {}), ...(s.asset_id ? { assetId: s.asset_id } : {}) } })} /> : null}</View></Card>)}
    </ScrollView><Modal visible={adding} onRequestClose={() => !busy && setAdding(false)} animationType="slide" transparent><View className="flex-1 justify-end bg-black/40"><ScrollView className="max-h-[90%] rounded-t-3xl bg-slate-50" contentContainerClassName="p-5"><Text className="mb-4 text-xl font-bold text-slate-900">{editingId ? "Edit schedule" : "New schedule"}</Text><Field label="Title" value={title} onChangeText={setTitle} /><Text className="mb-2 font-medium text-slate-600">Frequency</Text><View className="flex-row flex-wrap">{FREQS.map(f => chip(titleCase(f), frequency === f, () => setFrequency(f)))}</View>{frequency === "custom" ? <Field label="Interval in whole days" value={intervalDays} onChangeText={setIntervalDays} keyboardType="number-pad" /> : null}<Text className="mb-2 font-medium text-slate-600">Property</Text><View className="flex-row flex-wrap">{chip("Portfolio-wide", !propertyId, () => { if (scopeLocked) notify("Keep asset location", "This schedule is linked to an asset or unit. Create a separate schedule to change its location."); else setPropertyId(null); })}{properties.map(p => chip(p.name, propertyId === p.id, () => { if (scopeLocked && p.id !== propertyId) notify("Keep asset location", "This schedule is linked to an asset or unit. Create a separate schedule to change its location."); else setPropertyId(p.id); }))}</View><Field label="Next due date (YYYY-MM-DD)" value={nextDue} onChangeText={setNextDue} autoCapitalize="none" /><Text className="mb-2 font-medium text-slate-600">When should the next service be due?</Text><View className="flex-row flex-wrap">{chip("From completion", cadence === "completion", () => setCadence("completion"))}{chip("Keep fixed cadence", cadence === "scheduled", () => setCadence("scheduled"))}</View><Text className="mb-3 text-slate-500">Calendar months preserve month boundaries. Fixed cadence keeps the schedule anchored when work is completed late.</Text><View className="flex-row gap-3"><View className="flex-1"><Button title="Cancel" disabled={busy} variant="secondary" onPress={() => setAdding(false)} /></View><View className="flex-1"><Button title="Save" loading={busy} onPress={() => void save()} /></View></View></ScrollView></View></Modal>
    <Modal visible={!!completing} onRequestClose={() => !busy && setCompleting(null)} animationType="slide" transparent><View className="flex-1 justify-end bg-black/40"><View className="rounded-t-3xl bg-slate-50 p-5"><Text className="mb-3 text-xl font-bold text-slate-900">Record completion</Text><Field label="Completed on (YYYY-MM-DD)" value={completedOn} onChangeText={setCompletedOn} /><Field label="Work done / findings (optional)" value={notes} onChangeText={setNotes} multiline /><View className="flex-row gap-3"><View className="flex-1"><Button title="Cancel" disabled={busy} variant="secondary" onPress={() => setCompleting(null)} /></View><View className="flex-1"><Button title="Record completion" loading={busy} onPress={() => void markDone()} /></View></View></View></View></Modal>
    <Modal visible={history !== null} onRequestClose={() => setHistory(null)} animationType="slide"><Screen><ScrollView contentContainerClassName="p-5"><Text className="mb-4 text-xl font-bold text-slate-900">{historyTitle} · history</Text><Button title="Close history" variant="secondary" onPress={() => setHistory(null)} />{history?.length ? history.map(h => <Card key={h.id}><Text className="font-semibold text-slate-800">{formatDate(h.completed_on)}</Text>{h.notes ? <Text className="mt-1 text-slate-600">{h.notes}</Text> : null}<Text className="mt-1 text-slate-500">Next scheduled: {formatDate(h.next_due)}</Text></Card>) : <EmptyState title="No completions yet" />}</ScrollView></Screen></Modal>
  </Screen>;
}
