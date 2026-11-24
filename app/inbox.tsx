import { Redirect, useRouter, type Href } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button, Card, Loading, Screen } from "../components/ui";
import { useAuth } from "../lib/auth";
import type { InboxEvent, InboxLease } from "../lib/inboxTypes";
import { safeReturnPath } from "../lib/invites";
import { operationError } from "../lib/operationsQuery";
import { supabase } from "../lib/supabase";
import { useInboxRefresh } from "../lib/useInboxRefresh";

const PAGE = 30;
export default function Inbox() {
  const { session, initializing } = useAuth();
  if (initializing) return <Loading />;
  if (!session) return <Redirect href={{pathname:"/(auth)/login",params:{next:"/inbox"}}} />;
  return <InboxContent key={session.user.id} />;
}

function InboxContent() {
  const router = useRouter();
  const [activity, setActivity] = useState<InboxEvent[]>([]);
  const [leases, setLeases] = useState<InboxLease[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [section, setSection] = useState<"activity" | "messages">("activity");
  const [page, setPage] = useState(0);
  const refresh = useInboxRefresh(useCallback(async current => {
    try {
      const [events, threads] = await Promise.all([
        supabase.rpc("inbox_activity").order("created_at", { ascending: false }).order("id", {ascending:false}).range(page*PAGE,(page+1)*PAGE),
        supabase.rpc("inbox_leases").order("latest_at",{ascending:false,nullsFirst:false}).order("property_name").order("unit_label").order("lease_id").range(page*PAGE,(page+1)*PAGE),
      ]);
      if (events.error) throw events.error;
      if (threads.error) throw threads.error;
      if (!current()) return;
      setActivity(events.data); setLeases(threads.data); setError("");
    } catch (e) {
      if (current()) { setError(operationError(e)); setActivity([]); setLeases([]); }
    } finally { if (current()) setLoaded(true); }
  }, [page]));
  async function open(event: InboxEvent) {
    try {
      const result = await supabase.rpc("mark_inbox_read", { p_id: event.id });
      if (result.error) throw result.error;
      router.push(safeReturnPath(event.href) as Href);
    } catch (e) { setError(operationError(e)); }
  }
  return <Screen><ScrollView contentContainerClassName="mx-auto w-full max-w-2xl px-5 pb-10">
    <View className="my-3 flex-row items-center justify-between">
      <Text accessibilityRole="header" className="text-2xl font-bold text-slate-900">Inbox</Text>
      <Button title="Back" variant="secondary" onPress={() => router.canGoBack() ? router.back() : router.replace("/")} />
    </View>
    <View className="mb-4 flex-row gap-3">
      <Button title="Activity" variant={section==="activity"?"primary":"secondary"} onPress={()=>{setSection("activity");setPage(0);}} />
      <Button title="Lease messages" variant={section==="messages"?"primary":"secondary"} onPress={()=>{setSection("messages");setPage(0);}} />
    </View>
    {error ? <Card><Text accessibilityRole="alert" className="mb-2 text-red-700">{error}</Text><Button title="Retry" onPress={()=>void refresh()} /></Card> : null}
    {!loaded && <Loading />}
    {section==="activity" ? <>
      {loaded && !error && !activity.length && <Text className="text-slate-600">No activity yet. Repair updates, messages and notices will appear here.</Text>}
      {activity.slice(0,PAGE).map(e=><Card key={e.id} onPress={()=>void open(e)}>
        <Text className="text-sm text-brand">{e.read_at ? "Read" : "Unread"} · {new Date(e.created_at).toLocaleString()}</Text>
        <Text className="mt-1 text-base font-semibold text-slate-900">{e.title}</Text><Text numberOfLines={3} className="mt-1 text-slate-700">{e.body}</Text>
      </Card>)}
    </> : <>
      {loaded && !error && !leases.length && <Text className="text-slate-600">A current lease with a linked resident is needed to start a conversation.</Text>}
      {leases.slice(0,PAGE).map(l=><Card key={l.lease_id} onPress={()=>router.push(`/conversation/${l.lease_id}` as Href)}>
        <Text className="text-base font-semibold text-slate-900">{l.property_name} · {l.unit_label}</Text>
        <Text className="text-slate-700">{l.contact_name}{l.unread ? ` · ${l.unread} unread` : ""}</Text>
        <Text className="mt-1 text-slate-500" numberOfLines={2}>{l.last_message ?? "Start a lease conversation"}</Text>
      </Card>)}
    </>}
    {page>0 && <Button title="Previous page" variant="secondary" onPress={()=>setPage(n=>n-1)} />}
    {(section==="activity"?activity:leases).length>PAGE && <Button title="Next page" variant="secondary" onPress={()=>setPage(n=>n+1)} />}
  </ScrollView></Screen>;
}
