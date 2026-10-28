import { Ionicons } from "@expo/vector-icons";
import {
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, ScrollView, Text, View } from "react-native";

import { RequestConversation } from "../../../components/RequestConversation";
import {
  Badge,
  Button,
  Card,
  Field,
  Loading,
  Screen,
} from "../../../components/ui";
import type { Tables } from "../../../lib/database.types";
import { formatDate, titleCase } from "../../../lib/format";
import { useAuth } from "../../../lib/auth";
import { supabase } from "../../../lib/supabase";
import { operationError } from "../../../lib/operationsQuery";

const STATUS_COPY: Record<string, string> = {
  submitted: "Sent to your landlord. Waiting for them to look at it.",
  acknowledged: "Your landlord has seen this and is arranging the work.",
  in_progress: "Work is underway.",
  resolved: "Marked as fixed. Let your landlord know if it isn't.",
  closed: "This request is closed.",
};


export default function TenantRequestDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const {session}=useAuth();
  const uid=session?.user.id;
  const identity = `${uid ?? ""}:${id ?? ""}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const loadRevision = useRef(0);

  const [request, setRequest] = useState<Tables<"maintenance_requests"> | null>(
    null,
  );
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [location,setLocation]=useState("");

  const load = useCallback(async () => {
    if (!id || !uid) { setLoaded(true); return; }
    const revision = ++loadRevision.current;
    const current = () => currentIdentity.current === identity && loadRevision.current === revision;
    try {
      const { data, error: readError } = await supabase.from("maintenance_requests").select("*").eq("id", id).eq("tenant_user_id",uid).maybeSingle();
      if (readError) throw readError;
      let nextLocation = "";
      if(data){const {data:lease,error:leaseError}=await supabase.from("tenant_lease_details").select("property_name,unit_label").eq("lease_id",data.lease_id).maybeSingle();if(leaseError)throw leaseError;nextLocation=lease?[lease.property_name,lease.unit_label].filter(Boolean).join(" · "):"";}
      if (!current()) return;
      setLocation(nextLocation);
      setRequest(data); setError(data ? "" : "This request is unavailable or portal access has been removed.");
    } catch (e) { if(current()) setError(operationError(e)); }
    finally { if(current()) setLoaded(true); }
  }, [id,uid,identity]);
  useEffect(() => {
    setRequest(null); setLoaded(false); setLocation(""); setRating(0); setComment(""); setReason(""); setError(""); setBusy(false);
    return () => { loadRevision.current += 1; };
  }, [identity]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  useEffect(() => {
    const interval=setInterval(() => { if(AppState.currentState === "active") void load(); }, 12000);
    const foreground=AppState.addEventListener("change",state=>{if(state==="active")void load();});
    return()=>{clearInterval(interval);foreground.remove();};
  }, [load]);
  async function act(action: "rate" | "close" | "reopen") {
    if (!request || busy) return;
    if(action === "reopen" && reason.trim().length < 10){setError("Explain what still needs fixing in at least 10 characters.");return;}
    setBusy(true);setError("");
    try {
      const result = action === "rate"
        ? await supabase.rpc("rate_request_resolution", {p_request_id:request.id,p_rating:rating,p_comment:comment.trim()||null})
        : action === "close" ? await supabase.rpc("close_tenant_request", {p_request_id:request.id})
        : await supabase.rpc("reopen_tenant_request", {p_request_id:request.id,p_reason:reason.trim()});
      if(result.error)throw result.error;
      if(currentIdentity.current!==identity)return;
      setComment("");setReason("");await load();
    } catch(e){if(currentIdentity.current===identity)setError(operationError(e));}
    finally{if(currentIdentity.current===identity)setBusy(false);}
  }
  if (!loaded) return <Loading />;
  if (!request) return <Screen><View className="p-5"><Text accessibilityRole="alert" className="mb-4 text-red-700">{error || "Request unavailable."}</Text><Button title="Retry" onPress={()=>void load()}/><View className="mt-3"><Button title="Back to requests" variant="secondary" onPress={()=>router.replace("/tenant/requests")}/></View></View></Screen>;

  const canRate =
    (request.status === "resolved" || request.status === "closed") &&
    request.rating == null;

  return (
    <Screen>
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/tenant/requests")
          }
          accessibilityRole="button"
          accessibilityLabel="Back to requests"
          className="p-2"
        >
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text className="flex-1 text-xl font-bold text-slate-900" numberOfLines={1}>
          Request
        </Text>
      </View>

      <ScrollView
        contentContainerClassName="px-5 pb-10"
        keyboardShouldPersistTaps="handled"
      >
        {error ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" className="mb-3 text-red-700">{error}</Text> : null}
        <Card>
          {location ? <Text className="mb-2 text-sm text-slate-500">{location}</Text> : null}
          <View className="flex-row items-start justify-between">
            <Text className="flex-1 pr-2 text-xl font-bold text-slate-900">
              {request.title}
            </Text>
            <Badge label={request.status} />
          </View>
          {request.description ? (
            <Text className="mt-2 text-slate-600">{request.description}</Text>
          ) : null}
          <Text className="mt-3 text-slate-500">
            {STATUS_COPY[request.status] ?? ""}
          </Text>
          <Text className="mt-2 text-xs text-slate-400">
            {titleCase(request.category)} · {titleCase(request.urgency)} urgency ·
            reported {formatDate(request.created_at)}
          </Text>
        </Card>

        {request.rating != null ? (
          <Card>
            <Text className="text-sm font-semibold uppercase text-slate-400">
              Your rating
            </Text>
            <View className="mt-1 flex-row">
              {[1, 2, 3, 4, 5].map((n) => (
                <Ionicons
                  key={n}
                  name={n <= (request.rating ?? 0) ? "star" : "star-outline"}
                  size={20}
                  color="#f59e0b"
                />
              ))}
            </View>
            {request.rating_comment ? (
              <Text className="mt-2 text-slate-600">{request.rating_comment}</Text>
            ) : null}
          </Card>
        ) : null}

        {canRate ? (
          <Card>
            <Text className="text-base font-semibold text-slate-900">
              How did it go?
            </Text>
            <View className="mt-2 flex-row">
              {[1, 2, 3, 4, 5].map((n) => (
                <Pressable key={n} accessibilityRole="radio" accessibilityLabel={`${n} out of 5 stars`} accessibilityState={{checked:rating===n}} onPress={() => setRating(n)} className="mr-1 p-1">
                  <Ionicons
                    name={n <= rating ? "star" : "star-outline"}
                    size={28}
                    color="#f59e0b"
                  />
                </Pressable>
              ))}
            </View>
            <View className="mt-3">
              <Field
                label="Anything to add?"
                value={comment}
                onChangeText={setComment}
                multiline
                placeholder="Optional"
              />
              <Button
                title="Submit rating"
                onPress={() => act("rate")}
                loading={busy}
                disabled={rating === 0}
              />
            </View>
          </Card>
        ) : null}

        {request.status === "resolved" ? (
          <View className="mt-1">
            <Button
              title="Close this request"
              variant="secondary"
              onPress={() => act("close")}
              loading={busy}
            />
          </View>
        ) : null}

        {(request.status === "resolved" || request.status === "closed") ? <View className="mt-4"><Card><Text className="mb-3 font-semibold text-slate-900">Still not fixed?</Text><Field label="What still needs attention?" value={reason} onChangeText={setReason} multiline maxLength={2000} placeholder="Explain the remaining problem"/><Button title="Reopen request" variant="secondary" onPress={() => act("reopen")} loading={busy}/></Card></View> : null}
        <View className="mt-3"><Text className="text-sm text-slate-500">Sent {formatDate(request.created_at)} · Last update {formatDate(request.updated_at)}{request.resolved_at ? ` · Resolved ${formatDate(request.resolved_at)}` : ""}</Text></View>
        <RequestConversation
          requestId={request.id}
          locked={request.status === "closed"}
        />
      </ScrollView>
    </Screen>
  );
}
