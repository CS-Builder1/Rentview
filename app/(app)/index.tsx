import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";

import { Card, Loading, Screen } from "../../components/ui";
import { formatCurrency } from "../../lib/format";
import { supabase } from "../../lib/supabase";

type Summary = {
  properties: number;
  units: number;
  openWorkOrders: number;
  ytdSpend: number;
};

export default function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const yearStart = `${new Date().getFullYear()}-01-01`;

    const [props, units, openWos, expenses] = await Promise.all([
      supabase.from("properties").select("id", { count: "exact", head: true }),
      supabase.from("units").select("id", { count: "exact", head: true }),
      supabase
        .from("work_orders")
        .select("id", { count: "exact", head: true })
        .in("status", ["open", "in_progress", "on_hold"]),
      supabase.from("expenses").select("amount").gte("incurred_on", yearStart),
    ]);

    const ytdSpend = (expenses.data ?? []).reduce(
      (sum, row) => sum + Number(row.amount ?? 0),
      0,
    );

    setSummary({
      properties: props.count ?? 0,
      units: units.count ?? 0,
      openWorkOrders: openWos.count ?? 0,
      ytdSpend,
    });
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (!summary) return <Loading />;

  const tiles = [
    { label: "Properties", value: String(summary.properties) },
    { label: "Units", value: String(summary.units) },
    { label: "Open work orders", value: String(summary.openWorkOrders) },
    { label: "Spend this year", value: formatCurrency(summary.ytdSpend) },
  ];

  return (
    <Screen>
      <ScrollView
        contentContainerClassName="px-5 pb-10"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        <Text className="mb-1 mt-2 text-2xl font-bold text-slate-900">
          Overview
        </Text>
        <Text className="mb-5 text-slate-500">Your portfolio at a glance.</Text>

        <View className="flex-row flex-wrap justify-between">
          {tiles.map((t) => (
            <View key={t.label} className="mb-3 w-[48%]">
              <Card>
                <Text className="text-3xl font-bold text-brand">{t.value}</Text>
                <Text className="mt-1 text-slate-500">{t.label}</Text>
              </Card>
            </View>
          ))}
        </View>

        <Text className="mt-4 text-slate-400">
          Pull down to refresh. Add properties and units under the Properties
          tab, then log work orders to track spend.
        </Text>
      </ScrollView>
    </Screen>
  );
}
