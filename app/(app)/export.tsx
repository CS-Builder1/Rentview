import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Card, Loading, Screen } from "../../components/ui";
import { exportText, toCsv } from "../../lib/csv";
import type { Tables } from "../../lib/database.types";
import { titleCase } from "../../lib/format";
import { supabase } from "../../lib/supabase";

type Period = "this_year" | "last_year" | "all";

const PERIODS: { key: Period; label: string }[] = [
  { key: "this_year", label: "This year" },
  { key: "last_year", label: "Last year" },
  { key: "all", label: "All time" },
];

function notify(title: string, message: string) {
  Platform.OS === "web"
    ? window.alert(`${title}\n\n${message}`)
    : Alert.alert(title, message);
}

function periodBounds(period: Period): { start?: string; end?: string; label: string } {
  const y = new Date().getFullYear();
  if (period === "this_year")
    return { start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
  if (period === "last_year")
    return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31`, label: String(y - 1) };
  return { label: "all-time" };
}

export default function ExportPacket() {
  const router = useRouter();
  const [properties, setProperties] = useState<Tables<"properties">[] | null>(
    null,
  );
  const [propertyId, setPropertyId] = useState<string | null>(null); // null = all
  const [period, setPeriod] = useState<Period>("this_year");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from("properties").select("*").order("name");
    setProperties(data ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function run() {
    setBusy(true);
    try {
      const bounds = periodBounds(period);
      let q = supabase
        .from("expenses")
        .select(
          "incurred_on, amount, currency, category, description, properties(name), units(label), vendors(name)",
        )
        .order("incurred_on", { ascending: true });
      if (propertyId) q = q.eq("property_id", propertyId);
      if (bounds.start) q = q.gte("incurred_on", bounds.start);
      if (bounds.end) q = q.lte("incurred_on", bounds.end);

      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<{
        incurred_on: string;
        amount: number;
        currency: string;
        category: string;
        description: string | null;
        properties: { name: string } | null;
        units: { label: string } | null;
        vendors: { name: string } | null;
      }>;

      if (rows.length === 0) {
        notify("Nothing to export", "No expenses match that property and period.");
        return;
      }

      const headers = [
        "Date",
        "Property",
        "Unit",
        "Category",
        "Description",
        "Vendor",
        "Amount",
        "Currency",
      ];
      const body = rows.map((r) => [
        r.incurred_on,
        r.properties?.name ?? "",
        r.units?.label ?? "",
        titleCase(r.category),
        r.description ?? "",
        r.vendors?.name ?? "",
        Number(r.amount).toFixed(2),
        r.currency,
      ]);

      // Totals per currency appended after a blank row.
      const totals = new Map<string, number>();
      for (const r of rows)
        totals.set(r.currency, (totals.get(r.currency) ?? 0) + Number(r.amount));
      const totalRows: (string | number)[][] = [[]];
      for (const [cur, total] of totals)
        totalRows.push(["", "", "", "", "", `Total (${cur})`, total.toFixed(2), cur]);

      const csv = toCsv(headers, [...body, ...totalRows]);
      const prop = propertyId
        ? (properties?.find((p) => p.id === propertyId)?.name ?? "property")
        : "all-properties";
      const safe = prop.replace(/[^\w]+/g, "-").toLowerCase();
      const filename = `rentview-expenses-${safe}-${bounds.label}.csv`;

      await exportText(filename, "text/csv", csv);
      if (Platform.OS === "web") {
        notify("Export ready", `${rows.length} expense(s) downloaded as ${filename}.`);
      }
    } catch (e) {
      notify("Export failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!properties) return <Loading />;

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/more")
          }
          className="p-2"
        >
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text className="flex-1 text-xl font-bold text-slate-900">
          Accountant packet
        </Text>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        <Text className="mb-4 text-slate-500">
          Export expenses as a CSV to share with your accountant. Choose a
          property and period.
        </Text>

        <Text className="mb-1 text-sm font-medium text-slate-600">Property</Text>
        <View className="mb-4 flex-row flex-wrap">
          <Pressable
            onPress={() => setPropertyId(null)}
            className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
              !propertyId ? "border-brand bg-brand" : "border-slate-300 bg-white"
            }`}
          >
            <Text className={!propertyId ? "font-medium text-white" : "text-slate-700"}>
              All properties
            </Text>
          </Pressable>
          {properties.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => setPropertyId(p.id)}
              className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                propertyId === p.id
                  ? "border-brand bg-brand"
                  : "border-slate-300 bg-white"
              }`}
            >
              <Text
                className={
                  propertyId === p.id ? "font-medium text-white" : "text-slate-700"
                }
              >
                {p.name}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text className="mb-1 text-sm font-medium text-slate-600">Period</Text>
        <View className="mb-6 flex-row flex-wrap">
          {PERIODS.map((p) => (
            <Pressable
              key={p.key}
              onPress={() => setPeriod(p.key)}
              className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                period === p.key
                  ? "border-brand bg-brand"
                  : "border-slate-300 bg-white"
              }`}
            >
              <Text
                className={
                  period === p.key ? "font-medium text-white" : "text-slate-700"
                }
              >
                {p.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <Button
          title={busy ? "Preparing…" : "Export CSV"}
          onPress={run}
          loading={busy}
        />
        <Text className="mt-3 text-xs text-slate-400">
          The file includes date, property, unit, category, description,
          vendor and amount, with totals per currency. For your records —
          RentView is not tax or accounting advice.
        </Text>
      </ScrollView>
    </Screen>
  );
}
