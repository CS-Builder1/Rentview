import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";

import { Card, EmptyState, Loading, Screen } from "../../../components/ui";
import { cachedSelect } from "../../../lib/cache";
import type { Tables } from "../../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";

export default function TenantRent() {
  const [payments, setPayments] = useState<Tables<"rent_payments">[] | null>(
    null,
  );

  const load = useCallback(async () => {
    const data = await cachedSelect<Tables<"rent_payments">[]>(
      "tenant:payments",
      supabase
        .from("rent_payments")
        .select("*")
        .order("due_date", { ascending: false, nullsFirst: false }),
    );
    setPayments(data ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!payments) return <Loading />;

  const outstanding = payments.filter((p) => !p.paid_on);

  return (
    <Screen>
      <ScrollView contentContainerClassName="px-5 pb-10">
        <Text className="mb-1 mt-2 text-2xl font-bold text-slate-900">Rent</Text>
        <Text className="mb-5 text-slate-500">
          What your landlord has recorded. Payments are made the way you agreed
          with them — RentView does not collect rent.
        </Text>

        {outstanding.length > 0 ? (
          <Card>
            <Text className="text-sm font-semibold uppercase text-slate-400">
              Outstanding
            </Text>
            <Text className="mt-1 text-2xl font-bold text-slate-900">
              {formatCurrency(
                outstanding.reduce((sum, p) => sum + Number(p.amount), 0),
                outstanding[0].currency,
              )}
            </Text>
            <Text className="mt-1 text-slate-500">
              across {outstanding.length} unpaid record
              {outstanding.length === 1 ? "" : "s"}
            </Text>
          </Card>
        ) : null}

        {payments.length === 0 ? (
          <EmptyState
            title="Nothing recorded yet"
            subtitle="Payments your landlord logs will show up here."
          />
        ) : (
          payments.map((p) => (
            <Card key={p.id}>
              <View className="flex-row items-center justify-between">
                <Text className="text-base font-semibold text-slate-900">
                  {formatCurrency(p.amount, p.currency)}
                </Text>
                <Text
                  className={`text-xs font-medium ${
                    p.paid_on ? "text-green-700" : "text-amber-700"
                  }`}
                >
                  {p.paid_on ? "Paid" : "Unpaid"}
                </Text>
              </View>
              <Text className="mt-1 text-slate-500">
                {p.paid_on
                  ? `Paid ${formatDate(p.paid_on)}`
                  : p.due_date
                    ? `Due ${formatDate(p.due_date)}`
                    : "No due date"}
                {p.method ? ` · ${titleCase(p.method)}` : ""}
              </Text>
              {p.note ? (
                <Text className="mt-1 text-xs text-slate-400">{p.note}</Text>
              ) : null}
            </Card>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}
