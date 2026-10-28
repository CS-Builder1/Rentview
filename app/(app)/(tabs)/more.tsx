import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { NotificationPrefs } from "../../../components/NotificationPrefs";
import { Badge, Button, Card, Screen } from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import { formatDate } from "../../../lib/format";
import {
  FREE_PROPERTY_LIMIT,
  usePlan,
} from "../../../lib/plan";
import { supabase } from "../../../lib/supabase";


const MANAGE_LINKS = [
  { href: "/account", label: "Account & security", icon: "person-circle-outline" },
  { href: "/sync", label: "Saved work & sync", icon: "sync-outline" },
  { href: "/tenant", label: "My tenant portal", icon: "home-outline" },
  { href: "/requests", label: "Tenant requests", icon: "chatbubbles-outline" },
  { href: "/announcements", label: "Announcements", icon: "megaphone-outline" },
  { href: "/assets", label: "Assets", icon: "cube-outline" },
  { href: "/scan", label: "Scan asset tag", icon: "qr-code-outline" },
  { href: "/inventory", label: "Inventory & parts", icon: "file-tray-stacked-outline" },
  { href: "/vendors", label: "Vendors", icon: "people-outline" },
  { href: "/maintenance", label: "Preventive maintenance", icon: "calendar-outline" },
  { href: "/documents", label: "Documents", icon: "document-text-outline" },
  { href: "/expenses", label: "Expenses & analytics", icon: "cash-outline" },
  { href: "/export", label: "Accountant packet (CSV)", icon: "download-outline" },
] as const;

function notify(title: string, message: string) {
  Platform.OS === "web"
    ? window.alert(`${title}\n\n${message}`)
    : Alert.alert(title, message);
}

export default function More() {
  const router = useRouter();
  const { session, signOut } = useAuth();
  const { isPro, subscription } = usePlan();
  const [reminding, setReminding] = useState(false);

  async function sendReminders() {
    setReminding(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-reminders");
      if (error) throw error;
      const res = data as {
        emailConfigured: boolean;
        dueUsers: number;
        sent: number;
      };
      if (!res.emailConfigured) {
        notify(
          "Email not set up yet",
          "Email reminders are currently unavailable. Your due work remains visible under Maintenance.",
        );
      } else if (res.dueUsers === 0) {
        notify("Nothing due", "No warranties or maintenance are due right now.");
      } else if (res.sent > 0) {
        notify("Reminder sent", `Emailed your reminders to ${session?.user.email}.`);
      } else {
        notify("Could not send", "Reminders are due but the email didn't send. Check the sender configuration.");
      }
    } catch (e) {
      notify("Failed", e instanceof Error ? e.message : String(e));
    } finally {
      setReminding(false);
    }
  }

  const deleteAccount = () => router.push("/account");

  return (
    <Screen>
      <ScrollView contentContainerClassName="px-5 pb-10">
        <Text className="mb-1 mt-2 text-2xl font-bold text-slate-900">More</Text>
        <Text className="mb-5 text-slate-500">{session?.user.email}</Text>

        <Text className="mb-2 text-sm font-semibold uppercase text-slate-400">
          Manage
        </Text>
        {MANAGE_LINKS.map((link) => (
          <Pressable accessibilityRole="button" key={link.href} onPress={() => router.push(link.href)}>
            <Card>
              <View className="flex-row items-center">
                <Ionicons name={link.icon} size={20} color="#0f766e" />
                <Text className="ml-3 flex-1 text-base text-slate-700">
                  {link.label}
                </Text>
                <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />
              </View>
            </Card>
          </Pressable>
        ))}

        <Pressable onPress={() => router.push("/claim")}>
          <Card>
            <View className="flex-row items-center">
              <Ionicons name="key-outline" size={20} color="#0f766e" />
              <Text className="ml-3 flex-1 text-base text-slate-700">
                Join with an invite code
              </Text>
              <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />
            </View>
          </Card>
        </Pressable>

        <NotificationPrefs variant="owner" />

        <Text className="mb-2 mt-4 text-sm font-semibold uppercase text-slate-400">
          Reminders
        </Text>
        <Card>
          <Text className="text-slate-600">
            Get warranties expiring soon and maintenance due, by email.
          </Text>
          <View className="mt-3">
            <Button
              title="Email me my reminders"
              onPress={sendReminders}
              loading={reminding}
            />
          </View>
        </Card>

        <Text className="mb-2 mt-4 text-sm font-semibold uppercase text-slate-400">
          Plan & billing
        </Text>
        {subscription?.plan === "pro" && !subscription.billing_verified_at ? <Card><Text className="text-amber-800">Your subscription needs verification. Please contact support before starting another subscription.</Text></Card> : null}
        {isPro ? (
          <Card>
            <View className="flex-row items-center justify-between">
              <Text className="text-base font-semibold text-slate-900">
                RentView Pro
              </Text>
              {subscription ? <Badge label={subscription.status} /> : null}
            </View>
            <Text className="mt-1 text-slate-500">
              Unlimited properties, and everything else RentView does.
            </Text>
            {subscription?.current_period_end ? (
              <Text className="mt-3 text-slate-600">
                {subscription.cancel_at_period_end ||
                subscription.status === "cancelled"
                  ? `Ends ${formatDate(subscription.current_period_end)}`
                  : `Renews ${formatDate(subscription.current_period_end)}`}
              </Text>
            ) : null}
            <Text className="mt-3 text-xs text-slate-400">
              Manage or cancel from the receipt email your payment provider
              sent — {subscription?.provider === "paypal" ? "PayPal" : "Lemon Squeezy"}{" "}
              handles billing.
            </Text>
          </Card>
        ) : (
          <Card>
            <Text className="text-base font-semibold text-slate-900">
              RentView Pro
            </Text>
            <Text className="mt-1 text-slate-500">
              Unlimited properties. Free covers up to {FREE_PROPERTY_LIMIT},
              with every other feature included.
            </Text>
            <View className="mt-4 gap-2">
              <Button
                title="Subscriptions temporarily unavailable"
                disabled={true}
                onPress={() => notify("Subscriptions unavailable", "Secure checkout is being completed. Please try again later.")}
              />
              <Button
                title="PayPal signup unavailable"
                disabled={true}
                variant="secondary"
                onPress={() => notify("PayPal unavailable", "New subscriptions are currently unavailable.")}
              />
            </View>
            <Text className="mt-3 text-xs text-slate-400">
              New subscriptions are temporarily unavailable while secure checkout is completed. Existing verified subscriptions remain managed by their provider.
            </Text>
          </Card>
        )}

        <Text className="mb-2 mt-4 text-sm font-semibold uppercase text-slate-400">
          Account
        </Text>

        <Pressable accessibilityRole="button" onPress={() => void signOut().catch(error => notify("Could not sign out", error instanceof Error ? error.message : "Please retry."))}>
          <Card>
            <View className="flex-row items-center">
              <Ionicons name="log-out-outline" size={20} color="#475569" />
              <Text className="ml-3 text-base text-slate-700">Sign out</Text>
            </View>
          </Card>
        </Pressable>

        <Pressable onPress={deleteAccount} accessibilityRole="button">
          <Card>
            <View className="flex-row items-center">
              <Ionicons name="trash-outline" size={20} color="#dc2626" />
              <Text className="ml-3 text-base text-red-600">
                Delete account
              </Text>
            </View>
          </Card>
        </Pressable>

        <Text className="mt-4 text-xs text-slate-400">
          RentView keeps your records for you — it is not legal, tax or
          accounting advice. Consult your accountant for tax matters.
        </Text>
      </ScrollView>
    </Screen>
  );
}
