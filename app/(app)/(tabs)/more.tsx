import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Card, Screen } from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
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
  { href: "/assets", label: "Assets", icon: "cube-outline" },
  { href: "/inventory", label: "Inventory & parts", icon: "file-tray-stacked-outline" },
  { href: "/vendors", label: "Vendors", icon: "people-outline" },
  { href: "/maintenance", label: "Preventive maintenance", icon: "calendar-outline" },
  { href: "/documents", label: "Documents", icon: "document-text-outline" },
  { href: "/expenses", label: "Expenses & analytics", icon: "cash-outline" },
] as const;

export default function More() {
  const router = useRouter();
  const { session, signOut } = useAuth();
  const [deleting, setDeleting] = useState(false);

  const openCheckout = useCallback(async (url?: string) => {
    if (!url) {
      const msg =
        "Billing isn't wired up yet. Set the checkout URL in your environment to enable it.";
      Platform.OS === "web" ? window.alert(msg) : Alert.alert("Coming soon", msg);
      return;
    }
    await WebBrowser.openBrowserAsync(url);
  }, []);

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

        <Text className="mb-2 mt-4 text-sm font-semibold uppercase text-slate-400">
          Plan & billing
        </Text>
        <Card>
          <Text className="text-base font-semibold text-slate-900">
            RentView Pro
          </Text>
          <Text className="mt-1 text-slate-500">
            Unlimited properties & units, inventory, asset lifecycle,
            preventive maintenance and analytics.
          </Text>
          <View className="mt-4 gap-2">
            <Button
              title="Subscribe with Lemon Squeezy"
              onPress={() => openCheckout(LEMONSQUEEZY_URL)}
            />
            <Button
              title="Subscribe with PayPal"
              variant="secondary"
              onPress={() => openCheckout(PAYPAL_URL)}
            />
          </View>
          <Text className="mt-3 text-xs text-slate-400">
            Manage your subscription on the web. Prices shown at checkout.
          </Text>
        </Card>

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
