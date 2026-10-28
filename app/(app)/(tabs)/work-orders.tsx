import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { Badge, Button, Card, EmptyState, Field, Loading, Screen } from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import { cachedSelectResult } from "../../../lib/cache";
import { useOffline } from "../../../lib/offline";
import type { Tables } from "../../../lib/database.types";
import { Constants } from "../../../lib/database.types";
import { formatDate, titleCase } from "../../../lib/format";
import { notify } from "../../../lib/feedback";
import { supabase } from "../../../lib/supabase";
import { operationError } from "../../../lib/operationsQuery";
import { localToday } from "../../../lib/maintenance";

type WorkOrder = Tables<"work_orders"> & { properties: { name: string } | null; units: { label: string } | null };
const PRIORITIES = Constants.public.Enums.wo_priority;
const PAGE_SIZE = 50;
const FILTERS = ["active", "urgent", "overdue", "all"] as const;
type Filter = typeof FILTERS[number];
export default function WorkOrders() {
  const router = useRouter();
  const params = useLocalSearchParams<{ filter?: string; priority?: string; status?: string; propertyId?: string; unitId?: string; assetId?: string; new?: string }>();
  const { session } = useAuth();
  const { submitInsert } = useOffline();
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [properties, setProperties] = useState<Tables<"properties">[]>([]);
  const [units, setUnits] = useState<Tables<"units">[]>([]);
  const [assets, setAssets] = useState<Tables<"assets">[]>([]);
  const [filter, setFilter] = useState<Filter>(params.filter === "urgent" || params.priority === "urgent" ? "urgent" : params.filter === "overdue" ? "overdue" : params.filter === "all" ? "all" : "active");
  const [search, setSearch] = useState("");
  const [propertyFilter, setPropertyFilter] = useState(params.propertyId ?? "");
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false), [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const locationGeneration = useRef(0);
  const [adding, setAdding] = useState(false), [saving, setSaving] = useState(false);
  const [title, setTitle] = useState(""), [description, setDescription] = useState("");
  const [propertyId, setPropertyId] = useState<string | null>(null), [unitId, setUnitId] = useState<string | null>(null), [assetId, setAssetId] = useState<string | null>(null);
  const [priority, setPriority] = useState<typeof PRIORITIES[number]>("medium");
  const loadPage = useCallback(async (offset = 0) => {
    const ticket = ++generation.current;
    offset ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      let q = supabase.from("work_orders").select("*, properties!work_orders_property_id_owner_fk(name), units!work_orders_unit_property_owner_fk(label)", { count: "exact" }).order("due_date", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false }).order("id");
      if (filter !== "all") q = q.in("status", ["open", "in_progress", "on_hold"]);
      if (filter === "urgent") q = q.eq("priority", "urgent");
      if (filter === "overdue") q = q.lt("due_date", localToday());
      if (propertyFilter) q = q.eq("property_id", propertyFilter);
      if (search.trim()) q = q.ilike("title", `%${search.trim().replace(/[\\%_]/g, "\\$&")}%`);
      const result = await cachedSelectResult<{ rows: WorkOrder[]; total: number | null }>(`work-orders:${filter}:${propertyFilter}:${search}:${offset}`, (async () => {
        const response = await q.range(offset, offset + PAGE_SIZE - 1);
        return { data: { rows: (response.data ?? []) as WorkOrder[], total: response.count }, error: response.error };
      })());
      if (ticket !== generation.current) return;
      if (result.error) setError(result.error);
      if (!result.data && result.error) throw new Error(result.error);
      const data = result.data?.rows ?? [];
      if (ticket !== generation.current) return;
      setOrders(old => offset ? [...old, ...(data as WorkOrder[])] : data as WorkOrder[]);
      setHasMore(result.data?.total != null ? offset + data.length < result.data.total : data.length === PAGE_SIZE);
    } catch (e) { if (ticket === generation.current) setError(e instanceof Error ? e.message : "Work orders could not be loaded. Please retry."); }
    finally { if (ticket === generation.current) { setLoading(false); setLoadingMore(false); } }
  }, [filter, search, propertyFilter]);
  const load = useCallback(async () => {
    const [, result] = await Promise.all([loadPage(), cachedSelectResult<Tables<"properties">[]>("properties_min", supabase.from("properties").select("*").order("name"))]);
    setProperties(result.data ?? []);
  }, [loadPage]);
  useFocusEffect(useCallback(() => { void load(); return () => { generation.current++; }; }, [load]));
  useEffect(() => {
    const requested = params.filter ?? (params.priority === "urgent" ? "urgent" : "active");
    setFilter(FILTERS.includes(requested as Filter) ? requested as Filter : "active");
  }, [params.filter, params.priority]);
  useEffect(() => { setPropertyFilter(params.propertyId ?? ""); }, [params.propertyId]);
  async function pickProperty(pid: string, initialUnit: string | null = null, initialAsset: string | null = null) {
    const ticket = ++locationGeneration.current;
    setPropertyId(pid); setUnitId(initialUnit); setAssetId(initialAsset); setUnits([]); setAssets([]);
    const [u, a] = await Promise.all([supabase.from("units").select("*").eq("property_id", pid).order("label"), supabase.from("assets").select("*").eq("property_id", pid).order("name")]);
    if (ticket !== locationGeneration.current) return;
    if (u.error || a.error) { notify("Could not load location", u.error?.message ?? a.error!.message); return; }
    setUnits(u.data ?? []); setAssets(a.data ?? []);
  }
  useEffect(() => {
    if (params.new === "1" && params.propertyId) { void pickProperty(params.propertyId, params.unitId ?? null, params.assetId ?? null); setAdding(true); }
  }, [params.new, params.propertyId, params.unitId, params.assetId]);
  function resetForm() { locationGeneration.current++; setTitle(""); setDescription(""); setPropertyId(null); setUnitId(null); setAssetId(null); setUnits([]); setAssets([]); setPriority("medium"); }
  async function save() {
    if (!title.trim() || !propertyId || !session) { notify("Missing details", "Enter a title and choose a property."); return; }
    setSaving(true);
    try {
      const result = await submitInsert("work_orders", { owner_id: session.user.id, property_id: propertyId, unit_id: unitId, asset_id: assetId, title: title.trim(), description: description.trim() || null, priority });
      setAdding(false); resetForm();
      if (result === "queued") notify("Saved on this device", "Your work order is in Sync activity until it is uploaded.");
      else await loadPage();
    } catch (e) { notify("Could not save", operationError(e)); }
    finally { setSaving(false); }
  }
  const chip = (label: string, selected: boolean, onPress: () => void) => <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} className={`mb-2 mr-2 rounded-full border px-3 py-2 ${selected ? "border-brand bg-brand" : "border-slate-300 bg-white"}`}><Text className={selected ? "font-medium text-white" : "text-slate-700"}>{label}</Text></Pressable>;
  return <Screen>
    <View className="flex-row items-center justify-between px-5 pb-2 pt-2"><Text className="text-2xl font-bold text-slate-900">Work</Text><Button title="New job" onPress={() => { resetForm(); setAdding(true); }} /></View>
    <View className="px-5"><View className="mb-3 flex-row gap-2"><View className="flex-1"><Button title="Tenant requests" variant="secondary" onPress={() => router.push("/requests")} /></View><View className="flex-1"><Button title="Maintenance" variant="secondary" onPress={() => router.push("/maintenance")} /></View></View><Field label="Search job titles" value={search} onChangeText={setSearch} placeholder="e.g. AC repair" /><ScrollView horizontal contentContainerClassName="pb-1">{FILTERS.map(f => chip(titleCase(f), filter === f, () => { setFilter(f); router.setParams({ filter: f }); }))}</ScrollView><ScrollView horizontal contentContainerClassName="pb-1">{chip("All properties", !propertyFilter, () => { setPropertyFilter(""); router.setParams({ propertyId: "" }); })}{properties.map(p => chip(p.name, propertyFilter === p.id, () => { setPropertyFilter(p.id); router.setParams({ propertyId: p.id }); }))}</ScrollView></View>
    {error ? <View className="px-5"><Text accessibilityRole="alert" className="mb-2 text-red-700">{error}</Text><Button title="Retry" variant="secondary" onPress={() => void loadPage()} /></View> : null}
    {loading && !orders.length ? <Loading /> : <FlatList data={orders} keyExtractor={o => o.id} contentContainerStyle={{ padding: 20, paddingBottom: 40 }} onRefresh={() => void loadPage()} refreshing={loading} ListEmptyComponent={!error ? <EmptyState title="No jobs match" subtitle="Choose another filter or create a maintenance job." /> : null} ListFooterComponent={hasMore ? <Button title="Load more" loading={loadingMore} onPress={() => void loadPage(orders.length)} /> : null} renderItem={({ item: o }) => <Card onPress={() => router.push(`/work-order/${o.id}`)}><View className="flex-row items-center justify-between"><Text className="flex-1 pr-2 text-base font-semibold text-slate-900">{o.title}</Text><Badge label={o.priority} /></View><Text className="mt-1 text-slate-500">{o.properties?.name ?? "—"}{o.units?.label ? ` · ${o.units.label}` : " · Shared"}</Text><View className="mt-2 flex-row items-center justify-between"><Badge label={o.status} /><Text className="text-xs text-slate-500">{o.due_date ? `Due ${formatDate(o.due_date)}` : `Opened ${formatDate(o.created_at)}`}</Text></View></Card>} />}
    {adding ? <Modal visible onRequestClose={() => !saving && setAdding(false)} animationType="slide" transparent><View className="flex-1 justify-end bg-black/40"><ScrollView keyboardShouldPersistTaps="handled" className="max-h-[90%] rounded-t-3xl bg-slate-50" contentContainerClassName="p-5"><Text className="mb-4 text-xl font-bold text-slate-900">New work order</Text><Field label="Title" value={title} onChangeText={setTitle} /><Field label="Description (optional)" value={description} onChangeText={setDescription} multiline /><Text className="mb-2 font-medium text-slate-600">Property</Text><View className="flex-row flex-wrap">{properties.map(p => chip(p.name, propertyId === p.id, () => void pickProperty(p.id)))}</View>{!properties.length ? <Button title="Add your first property" variant="secondary" onPress={() => { setAdding(false); router.push("/properties"); }} /> : null}
      {propertyId ? <><Text className="mb-2 mt-2 font-medium text-slate-600">Unit</Text><View className="flex-row flex-wrap">{chip("Shared / common", !unitId, () => { setUnitId(null); setAssetId(null); })}{units.map(u => chip(u.label, unitId === u.id, () => { setUnitId(u.id); setAssetId(null); }))}</View><Text className="mb-2 mt-2 font-medium text-slate-600">Asset (optional)</Text><View className="flex-row flex-wrap">{chip("No asset", !assetId, () => setAssetId(null))}{assets.filter(a => !a.unit_id || a.unit_id === unitId).map(a => chip(a.name, assetId === a.id, () => setAssetId(a.id)))}</View></> : null}<Text className="mb-2 mt-2 font-medium text-slate-600">Priority</Text><View className="flex-row flex-wrap">{PRIORITIES.map(p => chip(titleCase(p), priority === p, () => setPriority(p)))}</View><View className="mt-3 flex-row gap-3"><View className="flex-1"><Button title="Cancel" variant="secondary" disabled={saving} onPress={() => setAdding(false)} /></View><View className="flex-1"><Button title="Save" loading={saving} onPress={() => void save()} /></View></View></ScrollView></View></Modal> : null}
  </Screen>;
}
