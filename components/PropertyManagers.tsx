import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { Button, Card, Field } from "./ui";
import { confirmAction } from "../lib/confirm";
import { supabase } from "../lib/supabase";
import { operationError } from "../lib/operationsQuery";

type Manager = { user_id: string; email: string };
type Invitation = { property_id: string; property_name: string };

export function ManagerInvitations({ accountId, onChange }: { accountId: string; onChange: () => void }) {
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [offers, setOffers] = useState<{from_owner: string;owner_email: string}[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [pending, transfers] = await Promise.all([
      supabase.rpc("my_manager_invitations"),
      supabase.from("portfolio_transfers").select("from_owner,owner_email").eq("to_manager", accountId).gt("expires_at", new Date().toISOString()),
    ]);
    setInvites(pending.data ?? []); setOffers(transfers.data ?? []);
    setError(pending.error?.message ?? transfers.error?.message ?? "");
  }, [accountId]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  async function accept(id: string, ownership: boolean) {
    setBusy(true);
    try {
      const result = ownership ? await supabase.rpc("accept_portfolio_transfer", { p_owner: id })
        : await supabase.rpc("accept_manager_invitation", { p_property: id });
      if (result.error) throw result.error;
      await load(); onChange();
    } catch (e) { setError(operationError(e)); } finally { setBusy(false); }
  }
  return <View>
    {error ? <Text accessibilityRole="alert">{error}</Text> : null}
    {invites.map(i => <Card key={i.property_id}><Text>{i.property_name}</Text>
      <Button title="Accept manager invitation" disabled={busy} onPress={() => void accept(i.property_id, false)} /></Card>)}
    {offers.map(o => <Card key={o.from_owner}><Text>{o.owner_email} offered you ownership of their entire portfolio, including shared contacts, files and financial records. Your plan must cover the combined property count.</Text>
      <Button title="Accept portfolio ownership" disabled={busy} onPress={() => confirmAction("Accept portfolio ownership", "You will control all records in the transferred portfolio. The former owner will lose access.", () => void accept(o.from_owner, true), "Accept ownership")} /></Card>)}
  </View>;
}

export function PropertyManagers({ propertyId }: { propertyId: string }) {
  const [members, setMembers] = useState<Manager[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [outgoing, setOutgoing] = useState<Manager | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [assigned, invited] = await Promise.all([
      supabase.from("property_managers").select("user_id,email").eq("property_id",propertyId).order("email"),
      supabase.from("manager_invitations").select("email").eq("property_id",propertyId).gt("expires_at",new Date().toISOString()).order("email"),
    ]);
    setMembers(assigned.data ?? []); setPending((invited.data ?? []).map(i=>i.email));
    if (assigned.error || invited.error) setMessage(assigned.error?.message ?? invited.error!.message);
  }, [propertyId]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  async function save(work: PromiseLike<{error: {message: string} | null}>, success: string) {
    setBusy(true); setMessage("");
    try {
      const result = await work;
      if (result.error) throw result.error;
      await load(); setMessage(success); setOutgoing(null);
    } catch(e) { setMessage(operationError(e)); } finally { setBusy(false); }
  }
  function remove(recipient: string) {
    confirmAction("Remove property access", recipient, () => void save(supabase.rpc("remove_property_manager", {p_property:propertyId,p_email:recipient}), "Access removed."), "Remove");
  }
  return <Card>
    <Text className="mb-2 text-lg font-semibold">Property managers</Text>
    <Field label="Manager email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
    <Button title="Create manager invitation" disabled={!email.trim() || busy} onPress={() => void save(supabase.rpc("invite_property_manager", {p_property:propertyId,p_email:email}), "Invitation ready. Ask the manager to verify this email and open Properties to accept within 14 days.")} />
    {pending.map(e => <View key={e} className="mt-3"><Text>Invited · {e}</Text><Button title="Withdraw invitation" variant="secondary" disabled={busy} onPress={()=>remove(e)} /></View>)}
    {members.map(m => <View key={m.user_id} className="mt-3 gap-2"><Text>{m.email}</Text>
      {outgoing && outgoing.user_id!==m.user_id ? <Button title="Confirm as replacement" disabled={busy} onPress={()=>void save(supabase.rpc("handover_property_manager",{p_property:propertyId,p_outgoing:outgoing.user_id,p_successor:m.user_id}),"Handover complete.")} /> : null}
      {members.length>1 && !outgoing ? <Button title="Hand over this assignment" variant="secondary" onPress={()=>setOutgoing(m)} /> : null}
      <Button title="Remove manager" variant="secondary" disabled={busy} onPress={()=>remove(m.email)} />
      <Button title="Offer portfolio ownership" variant="secondary" disabled={busy} onPress={()=>confirmAction("Offer ownership of every property", `When ${m.email} accepts, they will own your entire portfolio, including files and finances. They must already manage every property. Billing stays with each account.`,()=>void save(supabase.rpc("offer_portfolio_transfer",{p_successor:m.user_id}),"Offer ready. The successor can accept in Properties within seven days."),"Offer ownership")} />
    </View>)}
    {outgoing ? <Button title="Cancel handover" variant="secondary" onPress={()=>setOutgoing(null)} /> : null}
    {members.length ? <Button title="Withdraw ownership offer" variant="secondary" disabled={busy} onPress={()=>void save(supabase.rpc("cancel_portfolio_transfer"),"Ownership offer withdrawn.")} /> : null}
    {message ? <Text accessibilityLiveRegion="polite" className="mt-2">{message}</Text> : null}
  </Card>;
}
