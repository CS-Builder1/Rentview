import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { Button, Card, EmptyState, Loading, Screen } from "../../components/ui";
import { cachedSelectResult } from "../../lib/cache";
import type { Tables } from "../../lib/database.types";
import { formatCurrency, formatDate } from "../../lib/format";
import { localToday } from "../../lib/maintenance";
import { operationError, readAllPages } from "../../lib/operationsQuery";
import { rentSummaries, type RentRecord } from "../../lib/tenantRent";
import { supabase } from "../../lib/supabase";

type Lease = Pick<Tables<"leases">, "id" | "tenant_name" | "status" | "end_date"> & {
  units: { label: string; properties: { name: string } | null } | null;
};
type Overview = { leases: Lease[]; balances: ReturnType<typeof rentSummaries> };

export default function LeaseOverview() {
  const router = useRouter();
  const { filter } = useLocalSearchParams<{ filter?: string }>();
  const [view, setView] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    const today = localToday();
    const result = await cachedSelectResult<Overview>("lease-overview:" + today, (async () => {
      const [leases, records] = await Promise.all([
        readAllPages<Lease>((from, to) => supabase.from("leases").select("id,tenant_name,status,end_date,units!leases_unit_id_owner_fk(label,properties!units_property_id_owner_fk(name))", { count: "exact" }).order("end_date", { nullsFirst: false }).order("id").range(from, to)),
        readAllPages<RentRecord>((from, to) => supabase.from("rent_record_balances").select("lease_id,amount,currency,paid_on,due_date,applied_amount", { count: "exact" }).is("paid_on", null).order("id").range(from, to)),
      ]);
      if (leases.error || records.error) return { data: null, error: leases.error || records.error };
      return { data: { leases: leases.data ?? [], balances: rentSummaries(records.data ?? [], today) }, error: null };
    })());
    setView(result.data); setError(result.error ? operationError(result.error) : ""); setLoading(false);
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const byLease = useMemo(() => {
    const map = new Map<string, Overview["balances"]>();
    for (const group of view?.balances ?? []) {
      const list = map.get(group.leaseId) ?? [];
      list.push(group); map.set(group.leaseId, list);
    }
    return map;
  }, [view]);
  if (!view && !error) return <Loading />;
  const today = localToday(), cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + 60);
  const leases = (view?.leases ?? []).filter(lease => {
    if (filter === "ending") return lease.status === "active" && !!lease.end_date && lease.end_date >= today && lease.end_date <= localToday(cutoff);
    if (filter === "overdue") return byLease.get(lease.id)?.some(group => group.overdue > 0);
    return true;
  });
  return <Screen><Stack.Screen options={{ title: "Rent and leases", headerShown: true }} />
    <FlatList data={leases} keyExtractor={item => item.id} contentContainerStyle={{ padding: 18 }} refreshing={loading} onRefresh={() => void load()}
      ListHeaderComponent={<View><View className="mb-3 flex-row flex-wrap gap-2">
        {([["all","All leases"],["overdue","Overdue rent"],["ending","Ending in 60 days"]] as const).map(([key,label]) =>
          <Button key={key} title={label} variant={(filter ?? "all") === key ? "primary" : "secondary"} onPress={() => router.setParams({ filter: key })} />)}
      </View>{!!error && <Card><Text accessibilityRole="alert">{view ? "Showing saved records. " : ""}{error}</Text><Button title="Retry" onPress={() => void load()}/></Card>}</View>}
      ListEmptyComponent={!error ? <EmptyState title="No matching leases" /> : null}
      renderItem={({ item }) => <Card onPress={() => router.push(`/lease/${item.id}`)}>
        <Text className="font-semibold text-slate-900">{item.tenant_name}</Text>
        <Text className="text-slate-600">{[item.units?.properties?.name,item.units?.label].filter(Boolean).join(" · ")} · {item.status}</Text>
        {item.end_date && <Text className="mt-1 text-slate-600">Lease ends {formatDate(item.end_date)}</Text>}
        {(byLease.get(item.id) ?? []).map(group => <Text key={group.currency} className="mt-1 text-slate-700">{group.currency} · Overdue {formatCurrency(group.overdue,group.currency)} · Due today {formatCurrency(group.due,group.currency)}</Text>)}
      </Card>}/>
  </Screen>;
}
