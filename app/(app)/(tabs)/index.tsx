import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";

import { Card, Loading, Screen } from "../../../components/ui";
import { formatCurrency, formatDate } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";

type Summary = {
  properties: number;
  units: number;
  openWorkOrders: number;
  ytdSpend: number;
};

type Alert = {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
  tone: "amber" | "red" | "slate";
};

const SOON_DAYS = 60;

export default function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const now = new Date();
    const yearStart = `${now.getFullYear()}-01-01`;
    const today = now.toISOString().slice(0, 10);
    const soon = new Date(now.getTime() + SOON_DAYS * 86400000)
      .toISOString()
      .slice(0, 10);

    const [props, units, openWos, expenses, urgentWos, dueSched, inventory, warranties] =
      await Promise.all([
        supabase.from("properties").select("id", { count: "exact", head: true }),
        supabase.from("units").select("id", { count: "exact", head: true }),
        supabase
          .from("work_orders")
          .select("id", { count: "exact", head: true })
          .in("status", ["open", "in_progress", "on_hold"]),
        supabase.from("expenses").select("amount").gte("incurred_on", yearStart),
        supabase
          .from("work_orders")
          .select("id", { count: "exact", head: true })
          .eq("priority", "urgent")
          .in("status", ["open", "in_progress", "on_hold"]),
        supabase
          .from("maintenance_schedules")
          .select("id", { count: "exact", head: true })
          .eq("is_active", true)
          .not("next_due", "is", null)
          .lte("next_due", today),
        supabase
          .from("inventory_items")
          .select("quantity, low_stock_threshold")
          .not("low_stock_threshold", "is", null),
        supabase
          .from("assets")
          .select("id", { count: "exact", head: true })
          .not("warranty_expiry", "is", null)
          .gte("warranty_expiry", today)
          .lte("warranty_expiry", soon),
      ]);

    const ytdSpend = (expenses.data ?? []).reduce(
      (sum, row) => sum + Number(row.amount ?? 0),
      0,
    );
    const lowStock = (inventory.data ?? []).filter(
      (i) => Number(i.quantity) <= Number(i.low_stock_threshold),
    ).length;

    setSummary({
      properties: props.count ?? 0,
      units: units.count ?? 0,
      openWorkOrders: openWos.count ?? 0,
      ytdSpend,
    });

    const next: Alert[] = [];
    if ((urgentWos.count ?? 0) > 0)
      next.push({
        key: "urgent",
        icon: "alert-circle",
        tone: "red",
        text: `${urgentWos.count} urgent work order${urgentWos.count === 1 ? "" : "s"} open`,
      });
    if ((dueSched.count ?? 0) > 0)
      next.push({
        key: "maint",
        icon: "calendar",
        tone: "amber",
        text: `${dueSched.count} maintenance task${dueSched.count === 1 ? "" : "s"} due`,
      });
    if (lowStock > 0)
      next.push({
        key: "stock",
        icon: "file-tray",
        tone: "amber",
        text: `${lowStock} item${lowStock === 1 ? "" : "s"} low on stock`,
      });
    if ((warranties.count ?? 0) > 0)
      next.push({
        key: "warranty",
        icon: "shield-checkmark",
        tone: "slate",
        text: `${warranties.count} warrant${warranties.count === 1 ? "y" : "ies"} expiring within ${SOON_DAYS} days`,
      });
    setAlerts(next);
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

  const toneColor = {
    red: "text-red-600",
    amber: "text-amber-600",
    slate: "text-slate-600",
  };

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

        <Text className="mb-2 mt-3 text-sm font-semibold uppercase text-slate-400">
          Needs attention
        </Text>
        {alerts.length === 0 ? (
          <Card>
            <View className="flex-row items-center">
              <Ionicons name="checkmark-circle" size={20} color="#16a34a" />
              <Text className="ml-2 text-slate-600">All clear — nothing pressing.</Text>
            </View>
          </Card>
        ) : (
          <Card>
            {alerts.map((a, idx) => (
              <View
                key={a.key}
                className={`flex-row items-center py-2 ${
                  idx < alerts.length - 1 ? "border-b border-slate-100" : ""
                }`}
              >
                <Ionicons
                  name={a.icon}
                  size={18}
                  color={
                    a.tone === "red"
                      ? "#dc2626"
                      : a.tone === "amber"
                        ? "#d97706"
                        : "#475569"
                  }
                />
                <Text className={`ml-3 ${toneColor[a.tone]}`}>{a.text}</Text>
              </View>
            ))}
          </Card>
        )}

        <Text className="mt-5 text-slate-400">
          Pull down to refresh. Manage assets, inventory, maintenance and
          expenses from the More tab.
        </Text>
      </ScrollView>
    </Screen>
  );
}
