import { Redirect, useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button, Card, Field, Loading, Screen } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { newRecordId } from "../../lib/id";
import type { InboxLease, LeaseMessage } from "../../lib/inboxTypes";
import { operationError } from "../../lib/operationsQuery";
import { supabase } from "../../lib/supabase";
import { useInboxRefresh } from "../../lib/useInboxRefresh";

const PAGE = 40;

export default function Conversation() {
  const { id } = useLocalSearchParams<{id: string}>();
  const { session, initializing } = useAuth();
  if (initializing) return <Loading />;
  if (!session) return <Redirect href={{pathname:"/(auth)/login",params:{next:`/conversation/${id}`}}} />;
  return <Thread key={`${id}:${session.user.id}`} id={id} uid={session.user.id} />;
}

function Thread({ id, uid }: { id: string; uid: string }) {
  const router = useRouter();
  const [lease, setLease] = useState<InboxLease | null>(null);
  const [messages, setMessages] = useState<LeaseMessage[]>([]);
  const [page, setPage] = useState(0);
  const [hasOlder, setHasOlder] = useState(false);
  const [body, setBody] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sendError, setSendError] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  const resident = useRef<string | null>(null);
  const pending = useRef<{ id:string; body:string; resident:string } | null>(null);
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[]);
  const refresh = useInboxRefresh(useCallback(async current => {
    try {
      const {data:scope,error:scopeError} = await supabase.rpc("inbox_leases",{p_lease:id}).maybeSingle();
      if (scopeError) throw scopeError;
      if (!current()) return;
      if (!scope || (resident.current && resident.current !== scope.resident_id)) {
        resident.current = null; pending.current = null;
        setBody(""); setSendError("");
        throw new Error("This tenancy has changed or access has ended. Return to the inbox to select a current lease.");
      }
      // Do not transfer an unsent draft to the next resident after turnover.
      resident.current = scope.resident_id;
      const result = await supabase.rpc("lease_thread", {p_lease:id,p_resident:scope.resident_id})
        .order("created_at",{ascending:false}).order("id",{ascending:false}).range(page*PAGE,(page+1)*PAGE);
      if (result.error) throw result.error;
      if (!current()) return;
      const newest = result.data[0];
      setMessages(result.data.slice(0,PAGE).reverse()); setHasOlder(result.data.length>PAGE);
      setLease(scope); setError("");
      if (page===0 && scope.unread && newest) {
        const read = await supabase.rpc("mark_thread_read",{p_href:`/conversation/${id}`,p_through:newest.created_at});
        if (read.error && current()) setError("Messages loaded. Read status could not be saved.");
      }
    } catch (e) {
      if (current()) { setLease(null); setMessages([]); setError(operationError(e)); }
    } finally { if (current()) setLoaded(true); }
  },[id,page]));
  async function send() {
    const text = body.trim();
    if (!lease || lock.current || !text) return;
    lock.current=true; setSending(true); setSendError("");
    try {
      if (!pending.current || pending.current.body!==text || pending.current.resident!==lease.resident_id) {
        pending.current={id:newRecordId(),body:text,resident:lease.resident_id};
      }
      const write = await supabase.rpc("send_lease_message",{p_lease:id,p_resident:lease.resident_id,p_id:pending.current.id,p_body:text});
      if (write.error) throw write.error;
      if (!alive.current) return;
      pending.current=null;
      setBody(previous=>previous.trim()===text?"":previous);
      if (page===0) await refresh(); else setPage(0);
    } catch (e) { if (alive.current) setSendError(operationError(e)); }
    finally { if (alive.current) {lock.current=false;setSending(false);} }
  }
  return <Screen><ScrollView contentContainerClassName="mx-auto w-full max-w-2xl px-5 pb-10" keyboardShouldPersistTaps="handled">
    <View className="my-3 flex-row items-center justify-between">
      <Text accessibilityRole="header" className="text-xl font-bold text-slate-900">Lease conversation</Text>
      <Button title="Inbox" variant="secondary" onPress={()=>router.replace("/inbox" as Href)} />
    </View>
    {error ? <Card><Text accessibilityRole="alert" className="mb-2 text-red-700">{error}</Text><Button title="Retry" onPress={()=>void refresh()} /></Card> : null}
    {!loaded && <Loading />}
    {lease && <>
      <Card><Text className="text-base font-semibold text-slate-900">{lease.property_name} · {lease.unit_label}</Text><Text className="text-slate-700">{lease.contact_name}</Text></Card>
      {hasOlder && <Button title="Older messages" variant="secondary" onPress={()=>setPage(n=>n+1)} />}
      {!messages.length && <Text className="mb-4 text-slate-600">Start a conversation about this lease.</Text>}
      {messages.map(m=><View key={m.id} className={`my-1 max-w-[90%] rounded-xl p-3 ${m.sender_id===uid?"self-end bg-teal-50":"self-start bg-white"}`}>
        <Text className="text-xs text-slate-600">{m.sender_id===uid?"You":m.sender_name} · {new Date(m.created_at).toLocaleString()}</Text>
        <Text selectable className="mt-1 text-slate-900">{m.body}</Text>
      </View>)}
      {page>0 && <Button title="Newer messages" variant="secondary" onPress={()=>setPage(n=>n-1)} />}
      <View className="mt-4"><Field label="Message" value={body} onChangeText={setBody} multiline maxLength={5000} /></View>
      {sendError ? <Text accessibilityRole="alert" className="mb-2 text-red-700">{sendError}</Text> : null}
      <Button title="Send message" onPress={()=>void send()} disabled={!body.trim()} loading={sending} />
    </>}
  </ScrollView></Screen>;
}
