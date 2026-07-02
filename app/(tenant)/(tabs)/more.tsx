import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { Avatar } from "../../../components/Avatar";
import { Card, Icon, Screen } from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import { cachedSelect } from "../../../lib/cache";
import type { Tables } from "../../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";

type LeaseDetails = Tables<"tenant_lease_details">;
type RentPayment = Tables<"rent_payments">;

function confirm(
  title: string,
  message: string,
  onConfirm: () => void,
  confirmLabel = "Confirm",
) {
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: confirmLabel, style: "destructive", onPress: onConfirm },
  ]);
}

export default function TenantMore() {
  const { session, signOut } = useAuth();
  const [lease, setLease] = useState<LeaseDetails | null>(null);
  const [payments, setPayments] = useState<RentPayment[]>([]);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const leases = await cachedSelect<LeaseDetails[]>(
      "tenant.lease",
      supabase.from("tenant_lease_details").select("*"),
    );
    const active = leases?.find((l) => l.status === "active") ?? leases?.[0] ?? null;
    setLease(active);
    if (active?.lease_id) {
      const pays = await cachedSelect<RentPayment[]>(
        "tenant.payments.all",
        supabase
          .from("rent_payments")
          .select("*")
          .eq("lease_id", active.lease_id)
          .order("due_date", { ascending: false }),
      );
      setPayments(pays ?? []);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const deleteAccount = useCallback(() => {
    confirm(
      "Delete account",
      "This permanently deletes your account. Your landlord keeps their own records, but your login and access are removed. This cannot be undone.",
      async () => {
        setDeleting(true);
        try {
          const { error } = await supabase.functions.invoke("delete-account");
          if (error) throw error;
          await signOut();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          Platform.OS === "web"
            ? window.alert(`Could not delete account\n\n${msg}`)
            : Alert.alert("Could not delete account", msg);
        } finally {
          setDeleting(false);
        }
      },
      "Delete",
    );
  }, [signOut]);

  const fullName = (session?.user.user_metadata?.full_name as string) ?? "Tenant";

  return (
    <Screen>
      <ScrollView contentContainerClassName="px-5 pb-10">
        <Text className="mb-4 mt-2 text-2xl font-bold text-slate-900 dark:text-slate-100">
          More
        </Text>

        <Card>
          <View className="flex-row items-center">
            <Avatar name={fullName} size="lg" />
            <View className="ml-3">
              <Text className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {fullName}
              </Text>
              <Text className="text-sm text-slate-500 dark:text-slate-400">
                {session?.user.email}
              </Text>
            </View>
          </View>
        </Card>

        {lease ? (
          <>
            <Text className="mb-2 mt-4 text-sm font-semibold uppercase text-slate-400 dark:text-slate-500">
              My lease
            </Text>
            <Card>
              {[
                ["Home", `${lease.unit_label} · ${lease.property_name}`],
                [
                  "Address",
                  [lease.address_line1, lease.city, lease.region, lease.country]
                    .filter(Boolean)
                    .join(", ") || "—",
                ],
                ["Term", `${formatDate(lease.start_date)} → ${formatDate(lease.end_date)}`],
                ["Rent", formatCurrency(lease.rent_amount, lease.rent_currency ?? "USD")],
                ["Deposit", formatCurrency(lease.deposit_amount, lease.rent_currency ?? "USD")],
                ["Status", titleCase(lease.status ?? "—")],
                ["Landlord", lease.landlord_name ?? "—"],
              ].map(([label, value]) => (
                <View key={label} className="flex-row justify-between py-1">
                  <Text className="text-slate-500 dark:text-slate-400">{label}</Text>
                  <Text className="ml-4 flex-1 text-right font-medium text-slate-900 dark:text-slate-100">
                    {value}
                  </Text>
                </View>
              ))}
            </Card>
          </>
        ) : null}

        {payments.length > 0 ? (
          <>
            <Text className="mb-2 mt-4 text-sm font-semibold uppercase text-slate-400 dark:text-slate-500">
              Payment history
            </Text>
            <Card>
              {payments.map((p, idx) => (
                <View
                  key={p.id}
                  className={`flex-row items-center justify-between py-2 ${
                    idx < payments.length - 1
                      ? "border-b border-slate-100 dark:border-slate-800"
                      : ""
                  }`}
                >
                  <View>
                    <Text className="font-medium text-slate-900 dark:text-slate-100">
                      {formatCurrency(p.amount, p.currency)}
                    </Text>
                    <Text className="text-xs text-slate-400 dark:text-slate-500">
                      {p.due_date ? `Due ${formatDate(p.due_date)}` : ""}
                      {p.method ? ` · ${titleCase(p.method)}` : ""}
                    </Text>
                  </View>
                  {p.paid_on ? (
                    <View className="flex-row items-center">
                      <Icon name="checkmark-circle" size={16} tone="success" />
                      <Text className="ml-1 text-sm text-slate-600 dark:text-slate-300">
                        {formatDate(p.paid_on)}
                      </Text>
                    </View>
                  ) : (
                    <View className="flex-row items-center">
                      <Icon name="time" size={16} tone="warning" />
                      <Text className="ml-1 text-sm text-slate-600 dark:text-slate-300">
                        Unpaid
                      </Text>
                    </View>
                  )}
                </View>
              ))}
            </Card>
          </>
        ) : null}

        <Text className="mb-2 mt-4 text-sm font-semibold uppercase text-slate-400 dark:text-slate-500">
          Account
        </Text>

        <Pressable onPress={signOut}>
          <Card>
            <View className="flex-row items-center">
              <Icon name="log-out-outline" size={20} tone="muted" />
              <Text className="ml-3 text-base text-slate-700 dark:text-slate-200">Sign out</Text>
            </View>
          </Card>
        </Pressable>

        <Pressable onPress={deleteAccount} disabled={deleting}>
          <Card>
            <View className="flex-row items-center">
              <Icon name="trash-outline" size={20} tone="danger" />
              <Text className="ml-3 text-base text-red-600 dark:text-red-400">
                {deleting ? "Deleting…" : "Delete account"}
              </Text>
            </View>
          </Card>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}
