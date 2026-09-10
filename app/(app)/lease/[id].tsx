import { Ionicons } from "@expo/vector-icons";
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useCallback, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  Text,
  View,
} from "react-native";

import {
  Badge,
  Button,
  Card,
  Field,
  Loading,
  Screen,
} from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import { cachedSelect } from "../../../lib/cache";
import { confirmAction } from "../../../lib/confirm";
import type { Tables } from "../../../lib/database.types";
import { Constants } from "../../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";

type Lease = Tables<"leases"> & {
  units: {
    label: string;
    property_id: string;
    properties: { name: string; currency: string } | null;
  } | null;
};

const METHODS = Constants.public.Enums.payment_method;

// Ambiguous characters (0/O, 1/I/L) are left out so a code read aloud or
// written on paper still works.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function newCode(length = 8): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function notify(title: string, message: string) {
  Platform.OS === "web"
    ? window.alert(`${title}\n\n${message}`)
    : Alert.alert(title, message);
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between border-b border-slate-100 py-2">
      <Text className="text-slate-500">{label}</Text>
      <Text className="flex-1 pl-4 text-right font-medium text-slate-800">
        {value}
      </Text>
    </View>
  );
}

export default function LeaseDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();

  const [lease, setLease] = useState<Lease | null>(null);
  const [invites, setInvites] = useState<Tables<"tenant_invites">[]>([]);
  const [payments, setPayments] = useState<Tables<"rent_payments">[]>([]);
  const [busy, setBusy] = useState(false);

  // record-payment modal
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [paidOn, setPaidOn] = useState("");
  const [method, setMethod] = useState<(typeof METHODS)[number]>("bank_transfer");
  const [note, setNote] = useState("");

  const currency =
    lease?.rent_currency ?? lease?.units?.properties?.currency ?? "USD";

  const load = useCallback(async () => {
    if (!id) return;
    const [leaseData, inviteData, paymentData] = await Promise.all([
      cachedSelect<Lease>(
        `lease:${id}`,
        supabase
          .from("leases")
          .select("*, units(label, property_id, properties(name, currency))")
          .eq("id", id)
          .single(),
      ),
      cachedSelect<Tables<"tenant_invites">[]>(
        `invites:${id}`,
        supabase
          .from("tenant_invites")
          .select("*")
          .eq("lease_id", id)
          .order("created_at", { ascending: false }),
      ),
      cachedSelect<Tables<"rent_payments">[]>(
        `payments:${id}`,
        supabase
          .from("rent_payments")
          .select("*")
          .eq("lease_id", id)
          .order("due_date", { ascending: false, nullsFirst: false }),
      ),
    ]);
    setLease(leaseData ?? null);
    setInvites(inviteData ?? []);
    setPayments(paymentData ?? []);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function generateInvite() {
    if (!lease || !session) return;
    setBusy(true);
    const { error } = await supabase.from("tenant_invites").insert({
      owner_id: session.user.id,
      lease_id: lease.id,
      code: newCode(),
      email: lease.tenant_email,
    });
    setBusy(false);
    if (error) {
      notify("Could not create invite", error.message);
      return;
    }
    load();
  }

  async function shareCode(code: string) {
    const message =
      `Join RentView to report repairs and see your rent history.\n\n` +
      `Your invite code: ${code}\n\n` +
      `Create an account, then enter this code under "Join with an invite code".`;
    if (Platform.OS === "web") {
      try {
        await navigator.clipboard.writeText(code);
        notify("Code copied", `${code} is on your clipboard.`);
      } catch {
        notify("Invite code", code);
      }
      return;
    }
    await Share.share({ message });
  }

  function revokeInvite(inviteId: string) {
    confirmAction(
      "Revoke invite",
      "The code stops working immediately. You can generate a new one.",
      async () => {
        await supabase.from("tenant_invites").delete().eq("id", inviteId);
        load();
      },
      "Revoke",
    );
  }

  function unlinkTenant() {
    if (!lease) return;
    confirmAction(
      "Remove portal access",
      "The tenant keeps their login but can no longer see this lease, its requests or its payment history. Use this when they move out.",
      async () => {
        await supabase
          .from("leases")
          .update({ tenant_user_id: null })
          .eq("id", lease.id);
        load();
      },
      "Remove",
    );
  }

  async function savePayment() {
    if (!lease || !session || !amount.trim()) return;
    setSaving(true);
    const { error } = await supabase.from("rent_payments").insert({
      owner_id: session.user.id,
      lease_id: lease.id,
      amount: Number(amount),
      currency,
      due_date: dueDate.trim() || null,
      paid_on: paidOn.trim() || null,
      method,
      note: note.trim() || null,
    });
    setSaving(false);
    if (error) {
      notify("Could not save", error.message);
      return;
    }
    setAdding(false);
    setAmount("");
    setDueDate("");
    setPaidOn("");
    setNote("");
    load();
  }

  function removePayment(paymentId: string) {
    confirmAction(
      "Delete payment",
      "This removes the record from the tenant's history too.",
      async () => {
        await supabase.from("rent_payments").delete().eq("id", paymentId);
        load();
      },
    );
  }

  if (!lease) return <Loading />;

  const activeInvite = invites.find(
    (i) => !i.claimed_at && new Date(i.expires_at) > new Date(),
  );
  const linked = Boolean(lease.tenant_user_id);

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          onPress={() =>
            router.canGoBack()
              ? router.back()
              : router.replace(`/unit/${lease.unit_id}`)
          }
          className="p-2"
        >
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text className="flex-1 text-xl font-bold text-slate-900" numberOfLines={1}>
          {lease.tenant_name}
        </Text>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        <Card>
          <View className="flex-row items-center justify-between">
            <Text className="text-base font-semibold text-slate-900">
              {[lease.units?.properties?.name, lease.units?.label]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            <Badge label={lease.status} />
          </View>
          <View className="mt-3">
            <Row
              label="Term"
              value={`${lease.start_date ? formatDate(lease.start_date) : "—"} → ${
                lease.end_date ? formatDate(lease.end_date) : "ongoing"
              }`}
            />
            <Row label="Rent" value={formatCurrency(lease.rent_amount, currency)} />
            {lease.deposit_amount != null ? (
              <Row
                label="Deposit"
                value={formatCurrency(lease.deposit_amount, currency)}
              />
            ) : null}
            {lease.tenant_phone ? (
              <Row label="Phone" value={lease.tenant_phone} />
            ) : null}
            {lease.tenant_email ? (
              <Row label="Email" value={lease.tenant_email} />
            ) : null}
          </View>
        </Card>

        {/* Tenant portal access */}
        <Text className="mb-2 mt-4 text-lg font-semibold text-slate-900">
          Tenant portal access
        </Text>

        {linked ? (
          <Card>
            <View className="flex-row items-center">
              <Ionicons name="checkmark-circle" size={20} color="#16a34a" />
              <Text className="ml-2 flex-1 text-slate-700">
                This tenant has portal access.
              </Text>
            </View>
            <Text className="mt-2 text-xs text-slate-400">
              They can report repairs, follow progress and see the rent history
              you record here.
            </Text>
            <View className="mt-3">
              <Button
                title="Remove portal access"
                variant="secondary"
                onPress={unlinkTenant}
              />
            </View>
          </Card>
        ) : activeInvite ? (
          <Card>
            <Text className="text-sm text-slate-500">
              Share this code with {lease.tenant_name}:
            </Text>
            <Text className="my-2 text-3xl font-bold tracking-[4px] text-brand">
              {activeInvite.code}
            </Text>
            <Text className="text-xs text-slate-400">
              Expires {formatDate(activeInvite.expires_at)} · single use
            </Text>
            <View className="mt-3 flex-row gap-3">
              <View className="flex-1">
                <Button
                  title={Platform.OS === "web" ? "Copy code" : "Share code"}
                  onPress={() => shareCode(activeInvite.code)}
                />
              </View>
              <View className="flex-1">
                <Button
                  title="Revoke"
                  variant="secondary"
                  onPress={() => revokeInvite(activeInvite.id)}
                />
              </View>
            </View>
          </Card>
        ) : (
          <Card>
            <Text className="text-slate-600">
              Generate a single-use code that links this lease to your tenant's
              login. They never see your costs, vendors or other units.
            </Text>
            <View className="mt-3">
              <Button
                title="Generate invite code"
                onPress={generateInvite}
                loading={busy}
              />
            </View>
          </Card>
        )}

        {/* Rent payments */}
        <View className="mb-2 mt-4 flex-row items-center justify-between">
          <Text className="text-lg font-semibold text-slate-900">
            Rent payments
          </Text>
          <Pressable
            onPress={() => setAdding(true)}
            className="flex-row items-center rounded-full bg-brand px-3 py-1.5"
          >
            <Ionicons name="add" color="#fff" size={16} />
            <Text className="ml-1 font-semibold text-white">Record</Text>
          </Pressable>
        </View>

        {payments.length === 0 ? (
          <Text className="mb-2 text-slate-400">
            Nothing recorded yet. RentView tracks what you log — it does not
            process payments.
          </Text>
        ) : (
          payments.map((p) => (
            <Card key={p.id}>
              <View className="flex-row items-center justify-between">
                <Text className="text-base font-semibold text-slate-900">
                  {formatCurrency(p.amount, p.currency)}
                </Text>
                <Pressable onPress={() => removePayment(p.id)}>
                  <Ionicons name="trash-outline" size={18} color="#dc2626" />
                </Pressable>
              </View>
              <Text className="mt-1 text-slate-500">
                {p.paid_on
                  ? `Paid ${formatDate(p.paid_on)}`
                  : p.due_date
                    ? `Due ${formatDate(p.due_date)} · unpaid`
                    : "Unpaid"}
                {p.method ? ` · ${titleCase(p.method)}` : ""}
              </Text>
              {p.note ? (
                <Text className="mt-1 text-xs text-slate-400">{p.note}</Text>
              ) : null}
            </Card>
          ))
        )}
      </ScrollView>

      <Modal visible={adding} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[88%] rounded-t-3xl bg-slate-50"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900">
              Record a payment
            </Text>
            <Field
              label={`Amount (${currency})`}
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
            />
            <Field
              label="Due date"
              value={dueDate}
              onChangeText={setDueDate}
              placeholder="YYYY-MM-DD"
              autoCapitalize="none"
            />
            <Field
              label="Paid on (leave blank if unpaid)"
              value={paidOn}
              onChangeText={setPaidOn}
              placeholder="YYYY-MM-DD"
              autoCapitalize="none"
            />

            <Text className="mb-1 text-sm font-medium text-slate-600">Method</Text>
            <View className="mb-3 flex-row flex-wrap">
              {METHODS.map((m) => (
                <Pressable
                  key={m}
                  onPress={() => setMethod(m)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    method === m
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  <Text
                    className={
                      method === m ? "font-medium text-white" : "text-slate-700"
                    }
                  >
                    {titleCase(m)}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Field label="Note" value={note} onChangeText={setNote} multiline />

            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <Button
                  title="Cancel"
                  variant="secondary"
                  onPress={() => setAdding(false)}
                />
              </View>
              <View className="flex-1">
                <Button title="Save" onPress={savePayment} loading={saving} />
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
