import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { NotificationPrefs } from "../../../components/NotificationPrefs";
import { Badge, Button, Card, Screen } from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import { formatDate } from "../../../lib/format";
import {
  FREE_PROPERTY_LIMIT,
  lemonSqueezyCheckoutUrl,
  usePlan,
} from "../../../lib/plan";
import { supabase } from "../../../lib/supabase";

const LEMONSQUEEZY_URL = process.env.EXPO_PUBLIC_LEMONSQUEEZY_STORE_URL;
const PAYPAL_URL = process.env.EXPO_PUBLIC_PAYPAL_PLAN_URL;

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

const MANAGE_LINKS = [
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
  const { isPro, subscription, refresh: refreshPlan } = usePlan();
  const [deleting, setDeleting] = useState(false);
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
          "Add a RESEND_API_KEY secret to the send-reminders function to enable email reminders.",
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

  const openCheckout = useCallback(
    async (url?: string) => {
      if (!url) {
        const msg =
          "Billing isn't wired up yet. Set the checkout URL in your environment to enable it.";
        Platform.OS === "web" ? window.alert(msg) : Alert.alert("Coming soon", msg);
        return;
      }
      await WebBrowser.openBrowserAsync(url);
      // The webhook may land while the browser is still open, so re-read on
      // return rather than making the user restart the app.
      refreshPlan();
    },
    [refreshPlan],
  );

  const deleteAccount = useCallback(() => {
    confirm(
      "Delete account",
      "This permanently deletes your account and all your properties, units, work orders and records. This cannot be undone.",
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

  return (
    <Screen>
      <ScrollView contentContainerClassName="px-5 pb-10">
        <Text className="mb-1 mt-2 text-2xl font-bold text-slate-900">More</Text>
        <Text className="mb-5 text-slate-500">{session?.user.email}</Text>

        <Text className="mb-2 text-sm font-semibold uppercase text-slate-400">
          Manage
        </Text>
        {MANAGE_LINKS.map((link) => (
          <Pressable key={link.href} onPress={() => router.push(link.href)}>
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
                title="Subscribe with Lemon Squeezy"
                onPress={() =>
                  openCheckout(
                    LEMONSQUEEZY_URL && session
                      ? lemonSqueezyCheckoutUrl(
                          LEMONSQUEEZY_URL,
                          session.user.id,
                          session.user.email,
                        )
                      : LEMONSQUEEZY_URL,
                  )
                }
              />
              <Button
                title="Subscribe with PayPal"
                variant="secondary"
                onPress={() => openCheckout(PAYPAL_URL)}
              />
            </View>
            <Text className="mt-3 text-xs text-slate-400">
              Prices shown at checkout. With PayPal, pay using the same email
              as this account so we can match the subscription to it.
            </Text>
          </Card>
        )}

        <Text className="mb-2 mt-4 text-sm font-semibold uppercase text-slate-400">
          Account
        </Text>

        <Pressable onPress={signOut}>
          <Card>
            <View className="flex-row items-center">
              <Ionicons name="log-out-outline" size={20} color="#475569" />
              <Text className="ml-3 text-base text-slate-700">Sign out</Text>
            </View>
          </Card>
        </Pressable>

        <Pressable onPress={deleteAccount} disabled={deleting}>
          <Card>
            <View className="flex-row items-center">
              <Ionicons name="trash-outline" size={20} color="#dc2626" />
              <Text className="ml-3 text-base text-red-600">
                {deleting ? "Deleting…" : "Delete account"}
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
