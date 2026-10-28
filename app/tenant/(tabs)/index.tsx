import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";

import { Badge, Button, Card, Loading, Screen } from "../../../components/ui";
import { cachedSelectResult } from "../../../lib/cache";
import { useAuth } from "../../../lib/auth";
import type { Tables } from "../../../lib/database.types";
import { formatCurrency, formatDate } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";
import { readAllPages } from "../../../lib/operationsQuery";

type LeaseView = Tables<"tenant_lease_details">;

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

export default function TenantHome() {
  const router = useRouter();
  const {session}=useAuth();
  const uid=session?.user.id;
  const [leases, setLeases] = useState<LeaseView[] | null>(null);
  const [announcements, setAnnouncements] = useState<Tables<"announcements">[]>(
    [],
  );
  const [openRequests, setOpenRequests] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error,setError] = useState("");

  const load = useCallback(async () => {
    if(!uid)return;
    const snapshot=await cachedSelectResult<{leases:LeaseView[];announcements:Tables<"announcements">[];openRequests:number}>("tenant:home",(async()=>{
      const leaseRes=await readAllPages<LeaseView>((from,to)=>supabase.from("tenant_lease_details").select("*",{count:"exact"}).order("lease_id").range(from,to));if(leaseRes.error)return{data:null,error:leaseRes.error};
      const activeLeases=(leaseRes.data??[]).filter(lease=>lease.status==="active");
      const ownerIds=[...new Set(activeLeases.map(lease=>lease.owner_id).filter((id):id is string=>!!id))];
      const propertyIds=new Set(activeLeases.map(lease=>lease.property_id).filter((id):id is string=>!!id));
      const noticeScope=`property_id.is.null${propertyIds.size?`,property_id.in.(${[...propertyIds].join(",")})`:""}`;
      const [announcementRes,requestRes]=await Promise.all([
        ownerIds.length?supabase.from("announcements").select("*").in("owner_id",ownerIds).or(noticeScope).order("created_at",{ascending:false}).limit(10):Promise.resolve({data:[],error:null}),
        supabase.from("maintenance_requests").select("id",{count:"exact",head:true}).eq("tenant_user_id",uid).in("status",["submitted","acknowledged","in_progress","resolved"]),
      ]);
      if(announcementRes.error)return{data:null,error:announcementRes.error};if(requestRes.error)return{data:null,error:requestRes.error};
      return{data:{leases:leaseRes.data??[],announcements:announcementRes.data,openRequests:requestRes.count??0},error:null};
    })());
    setLeases(snapshot.data?.leases??null);setAnnouncements(snapshot.data?.announcements??[]);setOpenRequests(snapshot.data?.openRequests??0);setError(snapshot.error?`${snapshot.stale?"Showing a saved view. ":""}${snapshot.error}`:"");
  }, [uid]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (!leases && !error) return <Loading />;
  if (!leases) return <Screen><View className="p-5"><Text accessibilityRole="alert" className="mb-3 text-red-700">{error}</Text><Button title="Retry" onPress={()=>void load()}/></View></Screen>;

  return (
    <Screen>
      <ScrollView
        contentContainerClassName="px-5 pb-10"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        <Text className="mb-1 mt-2 text-2xl font-bold text-slate-900">
          My leases
        </Text>
        <Text className="mb-5 text-slate-500">
          Report repairs and follow their progress.
        </Text>

        {error ? <Text accessibilityRole="alert" className="mb-4 text-red-700">{error}</Text> : null}
        {leases.length === 0 ? (
          <Card>
            <Text className="text-base font-semibold text-slate-900">
              No lease linked yet
            </Text>
            <Text className="mt-1 text-slate-500">
              Ask your landlord for an invite code, then enter it here to see
              your lease.
            </Text>
            <View className="mt-3">
              <Button
                title="Enter invite code"
                onPress={() => router.push("/claim")}
              />
            </View>
          </Card>
        ) : (
          leases.map((l) => (
            <Card key={l.lease_id}>
              <View className="flex-row items-start justify-between">
                <Text className="flex-1 pr-2 text-lg font-bold text-slate-900">
                  {[l.property_name, l.unit_label].filter(Boolean).join(" · ")}
                </Text>
                {l.status ? <Badge label={l.status} /> : null}
              </View>
              {l.address_line1 ? (
                <Text className="mt-1 text-slate-500">
                  {[l.address_line1, l.city, l.region, l.country]
                    .filter(Boolean)
                    .join(", ")}
                </Text>
              ) : null}
              <View className="mt-3">
                <Row
                  label="Rent"
                  value={formatCurrency(l.rent_amount, l.rent_currency ?? "USD")}
                />
                <Row
                  label="Term"
                  value={`${l.start_date ? formatDate(l.start_date) : "—"} → ${
                    l.end_date ? formatDate(l.end_date) : "ongoing"
                  }`}
                />
                {l.landlord_name ? (
                  <Row label="Landlord" value={l.landlord_name} />
                ) : null}
              </View>
            </Card>
          ))
        )}

        {leases.length > 0 ? (
          <View className="mt-2">
            <Button
              title="Report a repair"
              onPress={() => router.push("/tenant/new-request")}
            />
            {openRequests > 0 ? (
              <Pressable
                onPress={() => router.push("/tenant/requests")}
                className="mt-3"
              >
                <Card>
                  <View className="flex-row items-center">
                    <Ionicons name="time-outline" size={20} color="#0f766e" />
                    <Text className="ml-2 flex-1 text-slate-700">
                      {openRequests} open request{openRequests === 1 ? "" : "s"} or awaiting review
                    </Text>
                    <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />
                  </View>
                </Card>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <Text className="mb-2 mt-6 text-sm font-semibold uppercase text-slate-400">
          Notices
        </Text>
        <View className="mb-3"><Button title="View all notices" variant="secondary" onPress={()=>router.push("/tenant/notices" as never)}/></View>
        {announcements.length === 0 ? (
          <Card>
            <Text className="text-slate-500">
              Nothing from your landlord right now.
            </Text>
          </Card>
        ) : (
          announcements.map((a) => (
            <Card key={a.id}>
              <Text className="mb-1 text-xs text-slate-500">{a.property_id ? leases.find(l=>l.property_id===a.property_id)?.property_name ?? "Linked property" : `${leases.find(l=>l.owner_id===a.owner_id)?.landlord_name ?? "Landlord"} · All properties`}</Text>
              <Text className="text-base font-semibold text-slate-900">
                {a.title}
              </Text>
              {a.body ? (
                <Text className="mt-1 text-slate-600">{a.body}</Text>
              ) : null}
              <Text className="mt-2 text-xs text-slate-400">
                {formatDate(a.created_at)}
              </Text>
            </Card>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}
