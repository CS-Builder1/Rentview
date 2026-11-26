import { Redirect, useRouter, type Href } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button, Card, Loading, Screen } from "../components/ui";
import { useAuth } from "../lib/auth";
import type { InboxCursor, InboxEvent, InboxLease } from "../lib/inboxTypes";
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
  const [cursors, setCursors] = useState<(InboxCursor | null)[]>([null]);
  const [nextCursor, setNextCursor] = useState<InboxCursor | null>(null);
  const cursor = cursors[cursors.length - 1];
  const refresh = useInboxRefresh(useCallback(async current => {
    try {
      if (section === "activity") {
        const { data, error } = await supabase.rpc("inbox_activity", {
          p_before: cursor?.at ?? null, p_before_id: cursor?.id ?? null, p_limit: PAGE,
        });
        if (error) throw error;
        if (!current()) return;
        setActivity(data.events); setNextCursor(data.next);
      } else {
        const { data, error } = await supabase.rpc("inbox_leases").order("latest_at",{ascending:false,nullsFirst:false})
          .order("property_name").order("unit_label").order("lease_id").order("thread_id").range(page*PAGE,(page+1)*PAGE);
        if (error) throw error;
        if (!current()) return;
        setLeases(data);
      }
      setError("");
    } catch (e) {
      if (current()) { setError(operationError(e)); setActivity([]); setNextCursor(null); setLeases([]); }
    } finally { if (current()) setLoaded(true); }
  }, [page, section, cursor]));
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
      <Button title="Activity" variant={section==="activity"?"primary":"secondary"} onPress={()=>{setSection("activity");setPage(0);setCursors([null]);}} />
      <Button title="Lease messages" variant={section==="messages"?"primary":"secondary"} onPress={()=>{setSection("messages");setPage(0);}} />
    </View>
    {error ? <Card><Text accessibilityRole="alert" className="mb-2 text-red-700">{error}</Text><Button title="Retry" onPress={()=>void refresh()} /></Card> : null}
    {!loaded && <Loading />}
    {section==="activity" ? <>
      {loaded && !error && !activity.length && <Text className="text-slate-600">{nextCursor ? "No accessible events on this page. Older activity may be available." : "No activity on this page."}</Text>}
      {activity.slice(0,PAGE).map(e=><Card key={e.id} onPress={()=>void open(e)}>
        <Text className="text-sm text-brand">{e.read_at ? "Read" : "Unread"} · {new Date(e.created_at).toLocaleString()}</Text>
        <Text className="mt-1 text-base font-semibold text-slate-900">{e.title}</Text><Text numberOfLines={3} className="mt-1 text-slate-700">{e.body}</Text>
      </Card>)}
    </> : <>
      {loaded && !error && !leases.length && <Text className="text-slate-600">No lease conversations. A linked resident can start a conversation on a current lease.</Text>}
      {leases.slice(0,PAGE).map(l=><Card key={l.thread_id} onPress={()=>router.push(`/conversation/${l.lease_id}?thread=${l.thread_id}` as Href)}>
        <Text className="text-base font-semibold text-slate-900">{l.property_name} · {l.unit_label}</Text>
        <Text className="text-slate-700">{l.contact_name}{l.can_post ? "" : " · Archived · read only"}{l.unread ? ` · ${l.unread} unread` : ""}</Text>
        <Text className="mt-1 text-slate-500" numberOfLines={2}>{l.last_message ?? "Start a lease conversation"}</Text>
      </Card>)}
    </>}
    {(section === "activity" ? cursors.length > 1 : page > 0) && <Button title="Previous page" variant="secondary" onPress={()=>section === "activity" ? setCursors(prior=>prior.slice(0,-1)) : setPage(n=>n-1)} />}
    {(section==="activity" ? !!nextCursor : leases.length>PAGE) && <Button title="Next page" variant="secondary" onPress={()=>section === "activity" && nextCursor ? setCursors(prior=>[...prior,nextCursor]) : setPage(n=>n+1)} />}
  </ScrollView></Screen>;
}
