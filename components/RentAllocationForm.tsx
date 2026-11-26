import { useRef, useState } from "react";
import { Modal, ScrollView, Text, View } from "react-native";
import { Button, Field } from "./ui";
import type { Tables } from "../lib/database.types";
import { Constants } from "../lib/database.types";
import { newRecordId } from "../lib/id";
import { formatCurrency, formatDate, titleCase } from "../lib/format";
import { localTimeZone, localToday } from "../lib/maintenance";
import { operationError } from "../lib/operationsQuery";
import { supabase } from "../lib/supabase";
import { availableReceiptAmount, rentRemaining } from "../lib/tenantRent";
import { calendarDate, nonNegativeMoney } from "../lib/validation";

type Record = Tables<"rent_record_balances">;

export function RentAllocationForm({ charge, records, onCancel, onSaved }: {
  charge: Record; records: Record[]; onCancel: () => void; onSaved: () => void;
}) {
  const receipts = records.filter(r => r.currency === charge.currency && r.lease_id === charge.lease_id && availableReceiptAmount(r) > 0);
  const [receipt, setReceipt] = useState<Record | null>(null);
  const [amount, setAmount] = useState(String(rentRemaining(charge)));
  const [paidOn, setPaidOn] = useState(localToday());
  const [method, setMethod] = useState<(typeof Constants.public.Enums.payment_method)[number]>("bank_transfer");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const [operationId] = useState(newRecordId);
  const [newReceiptId] = useState(newRecordId);
  function choose(record: Record | null) {
    setReceipt(record);
    setAmount(String(Math.min(rentRemaining(charge), record ? rentRemaining(record) : Infinity)));
    setError("");
  }
  async function save() {
    if (sending.current) return;
    sending.current = true;
    setSaving(true);
    try {
      const value = nonNegativeMoney(amount, "Amount to apply");
      if (!value || value > rentRemaining(charge) || (receipt && value > rentRemaining(receipt))) throw new Error("Enter a positive amount within the available balance.");
      const date = receipt ? null : calendarDate(paidOn, "Received on");
      if (date && date > localToday()) throw new Error("Choose today or a past receipt date.");
      const result = await supabase.rpc("apply_rent_receipt", {
        p_operation_id: operationId, p_charge_id: charge.id, p_amount: value, p_receipt_id: receipt?.id ?? newReceiptId,
        ...(date ? { p_paid_on: date, p_method: method, p_note: note.trim(), p_time_zone: localTimeZone() } : {}),
      });
      if (result.error) throw result.error;
      onSaved();
    } catch (failure) { setError(operationError(failure)); }
    finally { sending.current = false; setSaving(false); }
  }
  return <Modal visible onRequestClose={() => !saving && onCancel()} animationType="slide" transparent>
    <View className="flex-1 justify-end bg-black/40"><ScrollView className="max-h-[90%] rounded-t-3xl bg-white" contentContainerClassName="p-5">
      <Text className="text-xl font-bold text-slate-900">Apply rent receipt</Text>
      <Text className="my-3 text-slate-600">Charge {formatCurrency(charge.amount, charge.currency)} · {charge.due_date ? formatDate(charge.due_date) : "No due date"} · {formatCurrency(rentRemaining(charge), charge.currency)} remaining</Text>
      <Button title="New receipt" variant={receipt ? "secondary" : "primary"} disabled={saving} onPress={() => choose(null)} />
      {receipts.length > 0 && <Text className="mt-3 text-slate-600">Or apply money already recorded</Text>}
      {receipts.map(r => <Button key={r.id} title={formatDate(r.paid_on) + " · " + formatCurrency(rentRemaining(r), r.currency) + " available" + (r.note ? " · " + r.note : "")}
        variant={receipt?.id === r.id ? "primary" : "secondary"} disabled={saving} onPress={() => choose(r)} />)}
      <Field label={"Amount to apply (" + charge.currency + ")"} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" editable={!saving}/>
      {!receipt && <>
        <Field label="Received on (YYYY-MM-DD)" value={paidOn} onChangeText={setPaidOn} editable={!saving} />
        <Text className="mb-2 font-medium text-slate-700">Payment method</Text>
        <View className="flex-row flex-wrap gap-2">{Constants.public.Enums.payment_method.map(m => <Button key={m} title={titleCase(m)} variant={method === m ? "primary" : "secondary"} disabled={saving} onPress={() => setMethod(m)} />)}</View>
        <Field label="Receipt note (optional)" value={note} onChangeText={setNote} editable={!saving} />
      </>}
      {!!error && <Text accessibilityRole="alert" className="my-2 text-red-700">{error}</Text>}
      <View className="mt-3 flex-row gap-2"><Button title="Cancel" variant="secondary" disabled={saving} onPress={onCancel} /><Button title="Apply receipt" loading={saving} onPress={() => void save()} /></View>
    </ScrollView></View>
  </Modal>;
}
