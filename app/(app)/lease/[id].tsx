import { Ionicons } from "@expo/vector-icons";
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
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
import { cachedSelectResult } from "../../../lib/cache";
import { confirmAction } from "../../../lib/confirm";
import type { Tables } from "../../../lib/database.types";
import { Constants } from "../../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";
import { createOnce } from "../../../lib/createOnce";
import { newRecordId } from "../../../lib/id";
import { inviteUrl } from "../../../lib/appUrl";
import { notify } from "../../../lib/feedback";
import { calendarDate, currencyCode, nonNegativeMoney } from "../../../lib/validation";
import { localToday } from "../../../lib/maintenance";
import { operationError, readAllPages } from "../../../lib/operationsQuery";

type Lease = Tables<"leases"> & {
  units: {
    label: string;
    property_id: string;
    properties: { name: string; currency: string } | null;
  } | null;
};

const METHODS = Constants.public.Enums.payment_method;

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
  const generation = useRef(0);
  const paymentDraftId = useRef<string | null>(null);
  const { session } = useAuth();

  const [lease, setLease] = useState<Lease | null>(null);
  const [invites, setInvites] = useState<Tables<"tenant_invites">[]>([]);
  const [payments, setPayments] = useState<Tables<"rent_payments">[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // record-payment modal
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [paidOn, setPaidOn] = useState("");
  const [method, setMethod] = useState<(typeof METHODS)[number]>("bank_transfer");
  const [note, setNote] = useState("");
  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [paymentCurrency, setPaymentCurrency] = useState("USD");

  const currency =
    lease?.rent_currency ?? lease?.units?.properties?.currency ?? "USD";

  const load = useCallback(async () => {
    const ticket = ++generation.current;
    if (!id) { setLoadError("Choose a lease to continue."); setLoading(false); return; }
    setRefreshing(true);
    const [leaseData, inviteData, paymentData] = await Promise.all([
      cachedSelectResult<Lease>(`lease:${id}`, supabase.from("leases")
        .select("*, units!leases_unit_id_owner_fk(label, property_id, properties!units_property_id_owner_fk(name, currency))").eq("id", id).single()),
      cachedSelectResult<Tables<"tenant_invites">[]>(`invites:${id}`,
        readAllPages<Tables<"tenant_invites">>((from, to) => supabase.from("tenant_invites")
          .select("*", { count: "exact" }).eq("lease_id", id).order("created_at", { ascending: false }).order("id").range(from, to))),
      cachedSelectResult<Tables<"rent_payments">[]>(`payments:${id}`,
        readAllPages<Tables<"rent_payments">>((from, to) => supabase.from("rent_payments")
          .select("*", { count: "exact" }).eq("lease_id", id).order("due_date", { ascending: false, nullsFirst: false }).order("id").range(from, to))),
    ]);
    if (ticket !== generation.current) return;
    setLease(leaseData.data); setInvites(inviteData.data ?? []); setPayments(paymentData.data ?? []);
    setLoadError([leaseData.error, inviteData.error, paymentData.error].filter(Boolean).join(" ") || null);
    setLoading(false);
    setRefreshing(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => { generation.current++; };
    }, [load]),
  );

  async function generateInvite() {
    if (!lease || !session || busy) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("create_tenant_invite", {
        p_lease_id: lease.id, p_email: lease.tenant_email || null,
      });
      if (error) throw error;
      if (!data?.code) throw new Error("No invitation was created. Please retry.");
      await load();
    } catch (error) { notify("Could not create invitation", operationError(error)); }
    finally { setBusy(false); }
  }

  async function shareCode(code: string) {
    try {
      const url = inviteUrl(code);
      const message = `Join RentView to report repairs and see your rent history.\n\n${url}\n\nInvitation code: ${code}`;
      if (Platform.OS === "web") {
        try { await navigator.clipboard.writeText(url); notify("Invitation link copied", "Share this link privately with your tenant. It continues through sign-in or account creation."); }
        catch { notify("Tenant invitation", message); }
      } else await Share.share({ message, url });
    } catch (error) { notify("Could not share invitation", operationError(error)); }
  }

  function revokeInvite(inviteId: string) {
    confirmAction(
      "Revoke invite",
      "The code stops working immediately. You can generate a new one.",
      async () => {
        if (busy) return;
        setBusy(true);
        try {
          const { error } = await supabase.from("tenant_invites").delete().eq("id", inviteId).select("id").single();
          if (error) throw error;
          await load();
        } catch (error) { notify("Could not revoke invitation", operationError(error)); }
        finally { setBusy(false); }
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
        if (busy) return;
        setBusy(true);
        try {
          const { error } = await supabase.from("leases").update({ tenant_user_id: null })
            .eq("id", lease.id).select("id").single();
          if (error) throw error;
          await load();
        } catch (error) { notify("Could not remove portal access", operationError(error)); }
        finally { setBusy(false); }
      },
      "Remove",
    );
  }

  function openPayment(payment?: Tables<"rent_payments">) {
    paymentDraftId.current = null;
    setEditingPaymentId(payment?.id ?? null);
    setAmount(payment ? String(payment.amount) : lease?.rent_amount == null ? "" : String(lease.rent_amount));
    setDueDate(payment?.due_date ?? ""); setPaidOn(payment?.paid_on ?? "");
    setMethod(payment?.method ?? "bank_transfer"); setNote(payment?.note ?? "");
    setPaymentCurrency(payment?.currency ?? currency); setAdding(true);
  }

  async function savePayment() {
    if (!lease || !session || saving) return;
    setSaving(true);
    try {
      const value = nonNegativeMoney(amount, "Payment amount");
      if (!value) throw new Error("Payment amount must be greater than zero.");
      const paid = calendarDate(paidOn, "Paid on", true);
      if (paid && paid > localToday()) throw new Error("Paid on cannot be in the future.");
      const payload = {
        amount: value, currency: currencyCode(paymentCurrency),
        due_date: calendarDate(dueDate, "Due date", true), paid_on: paid,
        method, note: note.trim() || null,
      };
      if (editingPaymentId) {
        const { error } = await supabase.from("rent_payments").update(payload).eq("id", editingPaymentId).select("id").single();
        if (error) throw error;
      } else {
        paymentDraftId.current ??= newRecordId();
        const record = { ...payload, id: paymentDraftId.current, owner_id: session.user.id, lease_id: lease.id };
        await createOnce(record,
          () => supabase.from("rent_payments").insert(record).select("id").single(),
          () => supabase.from("rent_payments").select("*").eq("id", record.id).single());
      }
      setAdding(false); setEditingPaymentId(null); await load();
    } catch (error) { notify("Could not save payment record", operationError(error)); }
    finally { setSaving(false); }
  }

  async function markPaid(payment: Tables<"rent_payments">) {
    if (payment.paid_on || busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.from("rent_payments").update({ paid_on: localToday() })
        .eq("id", payment.id).is("paid_on", null).select("id").single();
      if (error) throw error;
      await load();
    } catch (error) { notify("Could not mark payment paid", operationError(error)); }
    finally { setBusy(false); }
  }

  function removePayment(paymentId: string) {
    confirmAction(
      "Delete payment",
      "This removes the record from the tenant's history too.",
      async () => {
        if (busy) return;
        setBusy(true);
        try {
          const { error } = await supabase.from("rent_payments").delete().eq("id", paymentId).select("id").single();
          if (error) throw error;
          await load();
        } catch (error) { notify("Could not delete payment record", operationError(error)); }
        finally { setBusy(false); }
      },
    );
  }

  if (loading) return <Loading />;
  if (!lease) return <Screen><View className="p-5"><Text accessibilityRole="alert" className="mb-3 text-red-700">{loadError ?? "This lease is unavailable or you no longer have access."}</Text><Button title="Retry" onPress={() => void load()} /><Button title="Back to properties" variant="secondary" onPress={() => router.replace("/properties")} /></View></Screen>;

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
        <Button title="Refresh lease" variant="secondary" loading={refreshing} disabled={busy || saving} onPress={() => void load()} />
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        {loadError ? <View className="mb-3"><Text accessibilityRole="alert" className="mb-2 text-red-700">{loadError}</Text><Button title="Retry" variant="secondary" onPress={() => void load()} /></View> : null}
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
                disabled={busy}
              />
            </View>
          </Card>
        ) : activeInvite ? (
          <Card>
            <Text className="text-sm text-slate-500">
              Share this private invitation with {lease.tenant_name}:
            </Text>
            <Text className="my-2 text-3xl font-bold tracking-[4px] text-brand">
              {activeInvite.code}
            </Text>
            <Text className="text-xs text-slate-400">
              Expires {formatDate(activeInvite.expires_at)} · single use
              {activeInvite.email ? ` · Only ${activeInvite.email} can claim after verifying their email.` : ""}
            </Text>
            <View className="mt-3 flex-row gap-3">
              <View className="flex-1">
                <Button
                  title={Platform.OS === "web" ? "Copy invitation link" : "Share invitation link"}
                  onPress={() => shareCode(activeInvite.code)}
                />
              </View>
              <View className="flex-1">
                <Button
                  title="Revoke"
                  variant="secondary"
                  disabled={busy}
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
                title={lease.status === "active" ? "Generate tenant invitation" : "Activate the lease to invite"}
                disabled={lease.status !== "active"}
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
            onPress={() => openPayment()}
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
                <Pressable accessibilityRole="button" accessibilityLabel="Delete payment record" disabled={busy} onPress={() => removePayment(p.id)}>
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
              <View className="mt-3 flex-row gap-2"><Button title="Edit record" variant="secondary" disabled={busy} onPress={() => openPayment(p)} />{!p.paid_on ? <Button title="Mark paid today" disabled={busy} onPress={() => void markPaid(p)} /> : null}</View>
            </Card>
          ))
        )}
      </ScrollView>

      <Modal visible={adding} onRequestClose={() => !saving && setAdding(false)} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[88%] rounded-t-3xl bg-slate-50"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900">
              {editingPaymentId ? "Edit payment record" : "Record a payment"}
            </Text>
            <Field label="Currency" value={paymentCurrency} onChangeText={setPaymentCurrency} autoCapitalize="characters" maxLength={3} />
            <Field
              label={`Amount (${paymentCurrency})`}
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
                  disabled={saving}
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
