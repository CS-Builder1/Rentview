import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { Badge, Button, Card, EmptyState, Field, Loading, Screen } from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import { cachedSelectResult } from "../../../lib/cache";
import { readAllPages } from "../../../lib/operationsQuery";
import type { Tables } from "../../../lib/database.types";
import { formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";

export default function TenantRequests(){
 const router=useRouter();const {session}=useAuth();const uid=session?.user.id;const [requests,setRequests]=useState<Tables<"maintenance_requests">[]|null>(null);const [leases,setLeases]=useState<Tables<"tenant_lease_details">[]>([]);const [error,setError]=useState("");const [refreshing,setRefreshing]=useState(false);const [search,setSearch]=useState("");const [active,setActive]=useState(true);
 const load=useCallback(async()=>{
  if(!uid)return;setRefreshing(true);
  const snapshot=await cachedSelectResult<{requests:Tables<"maintenance_requests">[];leases:Tables<"tenant_lease_details">[]}>("tenant:requests",(async()=>{
   const [requestRes,leaseRes]=await Promise.all([
    readAllPages<Tables<"maintenance_requests">>((from,to)=>supabase.from("maintenance_requests").select("*",{count:"exact"}).eq("tenant_user_id",uid).order("created_at",{ascending:false}).order("id",{ascending:false}).range(from,to)),
    readAllPages<Tables<"tenant_lease_details">>((from,to)=>supabase.from("tenant_lease_details").select("*",{count:"exact"}).order("lease_id").range(from,to)),
   ]);
   if(requestRes.error)return{data:null,error:requestRes.error};if(leaseRes.error)return{data:null,error:leaseRes.error};
   return{data:{requests:requestRes.data??[],leases:leaseRes.data??[]},error:null};
  })());
  setRequests(snapshot.data?.requests??null);setLeases(snapshot.data?.leases??[]);setError(snapshot.error?`${snapshot.stale?"Showing saved requests. ":""}${snapshot.error}`:"");setRefreshing(false);
 },[uid]);

 useFocusEffect(useCallback(()=>{void load();},[load]));
 const locations=useMemo(()=>new Map(leases.map(lease=>[lease.lease_id,[lease.property_name,lease.unit_label].filter(Boolean).join(" · ")])),[leases]);
 const location=(id:string)=>locations.get(id)??"Linked lease";
 const visible=(requests??[]).filter(request=>(!active||request.status!=="closed")&&`${request.title} ${location(request.lease_id)}`.toLowerCase().includes(search.trim().toLowerCase()));
 if(!requests&&!error)return <Loading/>;
 return <Screen><FlatList
  data={visible}
  keyExtractor={request=>request.id}
  contentContainerStyle={{paddingHorizontal:20,paddingBottom:40}}
  refreshing={refreshing}
  onRefresh={()=>void load()}
  initialNumToRender={12}
  maxToRenderPerBatch={12}
  windowSize={7}
  keyboardShouldPersistTaps="handled"
  ListHeaderComponent={<View>
   <View className="mb-4 mt-2 flex-row items-center justify-between"><Text className="text-2xl font-bold text-slate-900">My requests</Text><Button title="New request" onPress={()=>router.push("/tenant/new-request")}/></View>
   {error?<View className="mb-4"><Text accessibilityRole="alert" className="mb-2 text-red-700">{error}</Text><Button title="Retry" variant="secondary" onPress={()=>void load()}/></View>:null}
   <Field label="Search requests or locations" value={search} onChangeText={setSearch}/>
   <View className="mb-4 flex-row gap-2"><Button title="Active" variant={active?"primary":"secondary"} onPress={()=>setActive(true)}/><Button title="All requests" variant={!active?"primary":"secondary"} onPress={()=>setActive(false)}/></View>
  </View>}
  ListEmptyComponent={requests?<EmptyState title={requests.length?"No matching requests":"No requests yet"} subtitle={requests.length?"Try All requests or change your search.":"Report a repair to send it to your landlord."}/>:null}
  renderItem={({item:request})=><Card onPress={()=>router.push(`/tenant/request/${request.id}`)}>
   <Text className="mb-2 text-sm text-slate-500">{location(request.lease_id)}</Text>
   <View className="flex-row items-start justify-between"><Text className="flex-1 pr-2 text-base font-semibold text-slate-900">{request.title}</Text><Badge label={request.status}/></View>
   <View className="mt-2 flex-row items-center"><Badge label={request.urgency}/><Text className="ml-2 text-xs text-slate-500">{titleCase(request.category)} · {formatDate(request.created_at)}</Text></View>
   {request.status==="resolved"?<Text className="mt-2 text-sm text-brand">Review the repair and let your landlord know if it is fixed.</Text>:null}
  </Card>}
 /></Screen>;
}
