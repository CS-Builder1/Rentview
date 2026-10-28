import { Ionicons } from "@expo/vector-icons";
import { Href, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";

import { Button, Card, Loading, Screen } from "../../../components/ui";
import { cachedSelectResult } from "../../../lib/cache";
import { requiredCount, totalsByCurrency } from "../../../lib/dashboard";
import { formatCurrency } from "../../../lib/format";
import { localToday } from "../../../lib/maintenance";
import { operationError, readAllPages } from "../../../lib/operationsQuery";
import { supabase } from "../../../lib/supabase";

type Attention = { key: string; icon: keyof typeof Ionicons.glyphMap; text: string; href: Href };
type Snapshot = { properties: number; units: number; jobs: number; spending: Record<string, number>; attention: Attention[] };

async function fetchSnapshot(): Promise<{ data: Snapshot | null; error: unknown }> {
  try {
    const today = localToday();
    const yearStart = `${today.slice(0, 4)}-01-01`;
    const soon = localToday(new Date(Date.now() + 60 * 86400000));
    const [properties, units, jobs, expenses, urgent, overdue, maintenance, inventory, warranties, requests] = await Promise.all([
      supabase.from("properties").select("id", { count: "exact", head: true }),
      supabase.from("units").select("id", { count: "exact", head: true }),
      supabase.from("work_orders").select("id", { count: "exact", head: true }).in("status", ["open", "in_progress", "on_hold"]),
      readAllPages<{ amount: number; currency: string }>((from, to) => supabase.from("expenses").select("amount,currency", { count: "exact" }).gte("incurred_on", yearStart).lte("incurred_on", today).order("id").range(from, to)),
      supabase.from("work_orders").select("id", { count: "exact", head: true }).eq("priority", "urgent").in("status", ["open", "in_progress", "on_hold"]),
      supabase.from("work_orders").select("id", { count: "exact", head: true }).lt("due_date", today).in("status", ["open", "in_progress", "on_hold"]),
      supabase.from("maintenance_schedules").select("id", { count: "exact", head: true }).eq("is_active", true).lte("next_due", today),
      readAllPages<{ quantity: number; low_stock_threshold: number | null }>((from, to) => supabase.from("inventory_items").select("quantity,low_stock_threshold", { count: "exact" }).not("low_stock_threshold", "is", null).order("id").range(from, to)),
      supabase.from("assets").select("id", { count: "exact", head: true }).gte("warranty_expiry", today).lte("warranty_expiry", soon),
      supabase.from("maintenance_requests").select("id", { count: "exact", head: true }).eq("status", "submitted"),
    ]);
    if (expenses.error) throw expenses.error;
    if (inventory.error) throw inventory.error;
    const attention: Attention[] = [];
    const add = (key: string, count: number, text: string, icon: Attention["icon"], href: Href) => { if (count) attention.push({ key, text: `${count} ${text}`, icon, href }); };
    add("requests", requiredCount(requests), "new tenant requests to triage", "chatbubble-ellipses", "/requests?filter=submitted");
    add("urgent", requiredCount(urgent), "urgent jobs", "alert-circle", "/work-orders?filter=urgent");
    add("overdue", requiredCount(overdue), "overdue jobs", "time-outline", "/work-orders?filter=overdue");
    add("maintenance", requiredCount(maintenance), "maintenance tasks due", "calendar", "/maintenance?filter=due");
    add("stock", (inventory.data ?? []).filter(row => Number(row.quantity) <= Number(row.low_stock_threshold)).length, "items low on stock", "file-tray", "/inventory?filter=low");
    add("warranties", requiredCount(warranties), "warranties expiring within 60 days", "shield-checkmark", "/assets?filter=warranty");
    return { data: { properties: requiredCount(properties), units: requiredCount(units), jobs: requiredCount(jobs), spending: totalsByCurrency(expenses.data ?? []), attention }, error: null };
  } catch (error) { return { data: null, error }; }
}

export default function Dashboard() {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    const result = await cachedSelectResult<Snapshot>("dashboard:v3", fetchSnapshot());
    setSnapshot(result.data);
    setStale(result.stale);
    setError(result.error ? operationError(result.error) : null);
    setLoading(false);
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  if (loading && !snapshot) return <Loading />;
  return <Screen><ScrollView contentContainerClassName="px-5 pb-10" refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
    <Text className="mb-1 mt-2 text-2xl font-bold text-slate-900">Home</Text>
    <Text className="mb-5 text-slate-500">What needs attention in your portfolio.</Text>
    {error ? <Card><Text accessibilityRole="alert" className="mb-3 text-red-700">{stale ? "Showing the last saved snapshot. " : "The portfolio could not be loaded. "}{error}</Text><Button title="Retry" onPress={() => void load()} /></Card> : null}
    {snapshot ? <>
      <View className="flex-row flex-wrap justify-between">{[
        { label: "Properties", value: snapshot.properties, href: "/properties" as Href },
        { label: "Units", value: snapshot.units, href: "/properties" as Href },
        { label: "Open jobs", value: snapshot.jobs, href: "/work-orders?filter=active" as Href },
      ].map(tile => <View className="mb-2 w-[48%]" key={tile.label}><Card onPress={() => router.push(tile.href)}><Text className="text-3xl font-bold text-brand">{tile.value}</Text><Text className="text-slate-600">{tile.label}</Text></Card></View>)}</View>
      {snapshot.properties === 0 && !error ? <Card><Text className="mb-2 text-lg font-semibold text-slate-900">Set up your first property</Text><Text className="mb-3 text-slate-600">Add a home, store or building, then its units. Next, invite a tenant or log your first maintenance job.</Text><Button title="Add a property" onPress={() => router.push("/properties?new=1")} /></Card> : null}
      <Text className="mb-3 mt-3 text-lg font-semibold text-slate-900">Needs attention</Text>
      {snapshot.attention.map(item => <Card key={item.key} onPress={() => router.push(item.href)}><View className="flex-row items-center"><Ionicons name={item.icon} size={22} color="#0f766e" /><Text className="ml-3 flex-1 text-slate-800">{item.text}</Text><Ionicons name="chevron-forward" size={18} color="#64748b" /></View></Card>)}
      {!snapshot.attention.length && !error && !stale ? <Card><Text className="text-slate-600">All clear — no current alerts.</Text></Card> : null}
      {!snapshot.attention.length && (error || stale) ? <Text className="mb-3 text-slate-600">Current alerts could not be confirmed. Open Work or retry.</Text> : null}
      <Text className="mb-3 mt-4 text-lg font-semibold text-slate-900">Spend this year</Text>
      <Card onPress={() => router.push("/expenses")}>{Object.entries(snapshot.spending).map(([currency, amount]) => <Text key={currency} className="text-xl font-bold text-brand">{formatCurrency(amount, currency)}</Text>)}{!Object.keys(snapshot.spending).length ? <Text className="text-slate-500">No expenses recorded this year.</Text> : null}<Text className="mt-2 text-slate-500">Totals stay separate for each currency.</Text></Card>
    </> : null}
    <View className="mt-4 gap-3"><Button title="Open Work" onPress={() => router.push("/work-orders")} /><Button title="View assets" variant="secondary" onPress={() => router.push("/assets")} /><Button title="Tenant requests" variant="secondary" onPress={() => router.push("/requests")} /></View>
  </ScrollView></Screen>;
}
