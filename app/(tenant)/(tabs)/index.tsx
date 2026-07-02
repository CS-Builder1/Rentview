import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";

import { GradientHeader } from "../../../components/GradientHeader";
import { SkeletonCard } from "../../../components/Skeleton";
import { Card, Icon, Screen } from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import { cachedSelect } from "../../../lib/cache";
import type { Tables } from "../../../lib/database.types";
import { formatCurrency, formatDate } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";
import { useTheme } from "../../../lib/theme";

type LeaseDetails = Tables<"tenant_lease_details">;
type RentPayment = Tables<"rent_payments">;
type Announcement = Tables<"announcements">;

function greetingForNow(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default function TenantHome() {
  const { session } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const [lease, setLease] = useState<LeaseDetails | null | undefined>(undefined);
  const [openRequests, setOpenRequests] = useState(0);
  const [payments, setPayments] = useState<RentPayment[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const leases = await cachedSelect<LeaseDetails[]>(
      "tenant.lease",
      supabase.from("tenant_lease_details").select("*"),
    );
    const active =
      leases?.find((l) => l.status === "active") ?? leases?.[0] ?? null;
    setLease(active);

    const [reqs, pays, anns] = await Promise.all([
      cachedSelect<{ id: string }[]>(
        "tenant.open_requests",
        supabase
          .from("maintenance_requests")
          .select("id")
          .in("status", ["submitted", "acknowledged", "in_progress"]),
      ),
      active
        ? cachedSelect<RentPayment[]>(
            "tenant.payments",
            supabase
              .from("rent_payments")
              .select("*")
              .eq("lease_id", active.lease_id!)
              .order("paid_on", { ascending: false, nullsFirst: false })
              .limit(3),
          )
        : Promise.resolve([]),
      cachedSelect<Announcement[]>(
        "tenant.announcements",
        supabase
          .from("announcements")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(5),
      ),
    ]);
    setOpenRequests(reqs?.length ?? 0);
    setPayments(pays ?? []);
    setAnnouncements(anns ?? []);
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

  if (lease === undefined) {
    return (
      <Screen>
        <GradientHeader greeting={`${greetingForNow()}, ${firstName}`} title="My home" />
        <View className="px-5 pt-4">
          <SkeletonCard />
          <SkeletonCard />
        </View>
      </Screen>
    );
  }

  const lastPaid = payments.find((p) => p.paid_on);

  return (
    <Screen>
      <ScrollView
        contentContainerClassName="pb-10"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <GradientHeader
          greeting={`${greetingForNow()}, ${firstName}`}
          title={lease ? `${lease.unit_label}` : "My home"}
          subtitle={
            lease
              ? [lease.property_name, lease.city].filter(Boolean).join(" · ")
              : "No lease linked yet"
          }
        />

        <View className="px-5 pt-4">
          {!lease ? (
            <Card>
              <Text className="text-base font-semibold text-slate-900 dark:text-slate-100">
                No lease connected
              </Text>
              <Text className="mt-1 text-slate-500 dark:text-slate-400">
                Ask your landlord for an invite code, then sign in again with it.
              </Text>
            </Card>
          ) : (
            <>
              {/* Rent at a glance */}
              <Card>
                <View className="flex-row items-center justify-between">
                  <View>
                    <Text className="text-sm text-slate-500 dark:text-slate-400">Rent</Text>
                    <Text className="mt-0.5 text-2xl font-bold text-slate-900 dark:text-slate-100">
                      {formatCurrency(lease.rent_amount, lease.rent_currency ?? "USD")}
                    </Text>
                    <Text className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                      per month
                    </Text>
                  </View>
                  <View className="items-end">
                    <View className="h-10 w-10 items-center justify-center rounded-full bg-brand-50 dark:bg-brand-950">
                      <Ionicons name="wallet" size={18} color={colors.brand} />
                    </View>
                    {lastPaid ? (
                      <Text className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                        Last paid {formatDate(lastPaid.paid_on)}
                      </Text>
                    ) : null}
                  </View>
                </View>
                {payments.length > 0 ? (
                  <View className="mt-3 border-t border-slate-100 pt-2 dark:border-slate-800">
                    {payments.map((p) => (
                      <View key={p.id} className="flex-row items-center justify-between py-1">
                        <Text className="text-sm text-slate-600 dark:text-slate-300">
                          {p.paid_on ? formatDate(p.paid_on) : `Due ${formatDate(p.due_date)}`}
                        </Text>
                        <View className="flex-row items-center">
                          <Text className="mr-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                            {formatCurrency(p.amount, p.currency)}
                          </Text>
                          <Ionicons
                            name={p.paid_on ? "checkmark-circle" : "time"}
                            size={16}
                            color={p.paid_on ? colors.success : colors.warning}
                          />
                        </View>
                      </View>
                    ))}
                  </View>
                ) : null}
              </Card>

              {/* Repairs shortcut */}
              <Card onPress={() => router.push("/(tenant)/(tabs)/requests")}>
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center">
                    <View className="h-10 w-10 items-center justify-center rounded-full bg-brand-50 dark:bg-brand-950">
                      <Ionicons name="construct" size={18} color={colors.brand} />
                    </View>
                    <View className="ml-3">
                      <Text className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        Repairs & requests
                      </Text>
                      <Text className="text-sm text-slate-500 dark:text-slate-400">
                        {openRequests > 0
                          ? `${openRequests} open request${openRequests === 1 ? "" : "s"}`
                          : "Something broken? Report it in a minute."}
                      </Text>
                    </View>
                  </View>
                  <Icon name="chevron-forward" size={18} tone="faint" />
                </View>
              </Card>

              {/* Lease summary */}
              <Card>
                <Text className="mb-2 text-sm font-semibold uppercase text-slate-400 dark:text-slate-500">
                  Lease
                </Text>
                {[
                  ["Term", `${formatDate(lease.start_date)} → ${formatDate(lease.end_date)}`],
                  ["Deposit", formatCurrency(lease.deposit_amount, lease.rent_currency ?? "USD")],
                  ["Landlord", lease.landlord_name ?? "—"],
                  [
                    "Address",
                    [lease.address_line1, lease.city, lease.region].filter(Boolean).join(", ") || "—",
                  ],
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
          )}

          {/* Announcements */}
          {announcements.length > 0 ? (
            <>
              <Text className="mb-2 mt-3 text-sm font-semibold uppercase text-slate-400 dark:text-slate-500">
                From your landlord
              </Text>
              {announcements.map((a) => (
                <Card key={a.id}>
                  <View className="flex-row items-center">
                    <Ionicons name="megaphone" size={16} color={colors.brand} />
                    <Text className="ml-2 flex-1 text-base font-semibold text-slate-900 dark:text-slate-100">
                      {a.title}
                    </Text>
                    <Text className="text-xs text-slate-400 dark:text-slate-500">
                      {formatDate(a.created_at)}
                    </Text>
                  </View>
                  {a.body ? (
                    <Text className="mt-1 text-slate-600 dark:text-slate-300">{a.body}</Text>
                  ) : null}
                </Card>
              ))}
            </>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}
