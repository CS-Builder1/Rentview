import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";

import { GradientHeader } from "../../../components/GradientHeader";
import { ProgressRing } from "../../../components/ProgressRing";
import { SkeletonCard, SkeletonStat } from "../../../components/Skeleton";
import { Card, PressableScale, Screen } from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import { cacheGet, cacheSet } from "../../../lib/cache";
import { formatCurrency } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";
import { useTheme } from "../../../lib/theme";

type Summary = {
  properties: number;
  units: number;
  occupiedUnits: number;
  openWorkOrders: number;
  ytdSpend: number;
  newRequests: number;
};

type Alert = {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
  tone: "amber" | "red" | "slate";
};

const SOON_DAYS = 60;

function greetingForNow(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const { session } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();

  const load = useCallback(async () => {
    const now = new Date();
    const yearStart = `${now.getFullYear()}-01-01`;
    const today = now.toISOString().slice(0, 10);
    const soon = new Date(now.getTime() + SOON_DAYS * 86400000)
      .toISOString()
      .slice(0, 10);

    try {
    const [
      props,
      units,
      occupied,
      openWos,
      expenses,
      urgentWos,
      dueSched,
      inventory,
      warranties,
      newRequests,
      endingLeases,
    ] =
      await Promise.all([
        supabase.from("properties").select("id", { count: "exact", head: true }),
        supabase.from("units").select("id", { count: "exact", head: true }),
        supabase
          .from("units")
          .select("id", { count: "exact", head: true })
          .eq("status", "occupied"),
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
        supabase
          .from("maintenance_requests")
          .select("id", { count: "exact", head: true })
          .eq("status", "submitted"),
        supabase
          .from("leases")
          .select("id", { count: "exact", head: true })
          .eq("status", "active")
          .not("end_date", "is", null)
          .gte("end_date", today)
          .lte("end_date", soon),
      ]);

    const ytdSpend = (expenses.data ?? []).reduce(
      (sum, row) => sum + Number(row.amount ?? 0),
      0,
    );
    const lowStock = (inventory.data ?? []).filter(
      (i) => Number(i.quantity) <= Number(i.low_stock_threshold),
    ).length;

    const nextSummary: Summary = {
      properties: props.count ?? 0,
      units: units.count ?? 0,
      occupiedUnits: occupied.count ?? 0,
      openWorkOrders: openWos.count ?? 0,
      ytdSpend,
      newRequests: newRequests.count ?? 0,
    };
    setSummary(nextSummary);

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
    if ((endingLeases.count ?? 0) > 0)
      next.push({
        key: "leases",
        icon: "document-text",
        tone: "amber",
        text: `${endingLeases.count} lease${endingLeases.count === 1 ? "" : "s"} ending within ${SOON_DAYS} days — time to talk renewal`,
      });
    setAlerts(next);
      await cacheSet("dashboard", { summary: nextSummary, alerts: next });
    } catch {
      // Offline (or a transient failure): fall back to the last snapshot.
      const cached = await cacheGet<{ summary: Summary; alerts: Alert[] }>(
        "dashboard",
      );
      setSummary(cached?.summary ?? {
        properties: 0,
        units: 0,
        occupiedUnits: 0,
        openWorkOrders: 0,
        ytdSpend: 0,
        newRequests: 0,
      });
      setAlerts(cached?.alerts ?? []);
    }
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

  const firstName =
    (session?.user.user_metadata?.full_name as string | undefined)
      ?.trim()
      .split(/\s+/)[0] ?? "there";

  if (!summary) {
    return (
      <Screen>
        <GradientHeader greeting={`${greetingForNow()}, ${firstName}`} title="Your portfolio" />
        <View className="mt-4 flex-row flex-wrap justify-between px-5">
          <SkeletonStat />
          <SkeletonStat />
        </View>
        <View className="px-5 pt-3">
          <SkeletonCard />
          <SkeletonCard />
        </View>
      </Screen>
    );
  }

  const occupancy = summary.units > 0 ? summary.occupiedUnits / summary.units : 0;

  const tiles: {
    label: string;
    value: string;
    icon: keyof typeof Ionicons.glyphMap;
    onPress?: () => void;
  }[] = [
    {
      label: "Properties",
      value: String(summary.properties),
      icon: "business",
      onPress: () => router.push("/(app)/(tabs)/properties"),
    },
    {
      label: "Units",
      value: String(summary.units),
      icon: "home",
      onPress: () => router.push("/(app)/(tabs)/properties"),
    },
    {
      label: "Open work orders",
      value: String(summary.openWorkOrders),
      icon: "construct",
      onPress: () => router.push("/(app)/(tabs)/work-orders"),
    },
    {
      label: "Spend this year",
      value: formatCurrency(summary.ytdSpend),
      icon: "wallet",
      onPress: () => router.push("/(app)/expenses"),
    },
  ];

  const quickActions: {
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
    onPress: () => void;
  }[] = [
    { label: "Scan tag", icon: "qr-code", onPress: () => router.push("/(app)/scan") },
    { label: "Maintenance", icon: "calendar", onPress: () => router.push("/(app)/maintenance") },
    { label: "Expenses", icon: "wallet", onPress: () => router.push("/(app)/expenses") },
    { label: "Export", icon: "download", onPress: () => router.push("/(app)/export") },
  ];

  const toneColor = {
    red: "text-red-600 dark:text-red-400",
    amber: "text-amber-600 dark:text-amber-400",
    slate: "text-slate-600 dark:text-slate-300",
  };
  const toneIcon = {
    red: colors.danger,
    amber: colors.warning,
    slate: colors.inkMuted,
  };

  return (
    <Screen>
      <ScrollView
        contentContainerClassName="pb-10"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        <GradientHeader
          greeting={`${greetingForNow()}, ${firstName}`}
          title="Your portfolio"
          subtitle={`${summary.properties} propert${summary.properties === 1 ? "y" : "ies"} · ${summary.units} unit${summary.units === 1 ? "" : "s"}`}
          right={
            summary.units > 0 ? (
              <View className="rounded-2xl bg-white/10 p-2">
                <ProgressRing progress={occupancy} label="occupied" size={68} />
              </View>
            ) : undefined
          }
        />

        <View className="mt-4 flex-row flex-wrap justify-between px-5">
          {tiles.map((t) => (
            <View key={t.label} className="mb-3 w-[48%]">
              <Card onPress={t.onPress}>
                <View className="h-8 w-8 items-center justify-center rounded-full bg-brand-50 dark:bg-brand-950">
                  <Ionicons name={t.icon} size={15} color={colors.brand} />
                </View>
                <Text className="mt-2 text-2xl font-bold text-slate-900 dark:text-slate-100">
                  {t.value}
                </Text>
                <Text className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                  {t.label}
                </Text>
              </Card>
            </View>
          ))}
        </View>

        <View className="mb-1 flex-row justify-between px-5">
          {quickActions.map((a) => (
            <PressableScale key={a.label} onPress={a.onPress} className="items-center">
              <View className="h-12 w-12 items-center justify-center rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-surface-dark">
                <Ionicons name={a.icon} size={20} color={colors.brand} />
              </View>
              <Text className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {a.label}
              </Text>
            </PressableScale>
          ))}
        </View>

        <View className="px-5">
          {summary.newRequests > 0 ? (
            <View className="mt-5">
              <Card onPress={() => router.push("/(app)/requests")}>
                <View className="flex-row items-center">
                  <View className="h-10 w-10 items-center justify-center rounded-full bg-brand-50 dark:bg-brand-950">
                    <Ionicons name="chatbubbles" size={18} color={colors.brand} />
                  </View>
                  <View className="ml-3 flex-1">
                    <Text className="text-base font-semibold text-slate-900 dark:text-slate-100">
                      {summary.newRequests} new tenant request
                      {summary.newRequests === 1 ? "" : "s"}
                    </Text>
                    <Text className="text-sm text-slate-500 dark:text-slate-400">
                      Tap to triage
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.inkFaint} />
                </View>
              </Card>
            </View>
          ) : null}
          <Text className="mb-2 mt-5 text-sm font-semibold uppercase text-slate-400 dark:text-slate-500">
            Needs attention
          </Text>
          {alerts.length === 0 ? (
            <Card>
              <View className="flex-row items-center">
                <Ionicons name="checkmark-circle" size={20} color={colors.success} />
                <Text className="ml-2 text-slate-600 dark:text-slate-300">
                  All clear — nothing pressing.
                </Text>
              </View>
            </Card>
          ) : (
            <Card>
              {alerts.map((a, idx) => (
                <View
                  key={a.key}
                  className={`flex-row items-center py-2 ${
                    idx < alerts.length - 1
                      ? "border-b border-slate-100 dark:border-slate-800"
                      : ""
                  }`}
                >
                  <Ionicons name={a.icon} size={18} color={toneIcon[a.tone]} />
                  <Text className={`ml-3 ${toneColor[a.tone]}`}>{a.text}</Text>
                </View>
              ))}
            </Card>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}
