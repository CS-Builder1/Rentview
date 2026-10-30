import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button, Card, EmptyState, Loading, Screen } from "../../components/ui";
import type { Tables } from "../../lib/database.types";
import { formatDate } from "../../lib/format";
import { supabase } from "../../lib/supabase";
import { readAllPages } from "../../lib/operationsQuery";

export default function TenantNotices(){
 const router=useRouter();const [notices,setNotices]=useState<Tables<"announcements">[]>([]);const [leases,setLeases]=useState<Tables<"tenant_lease_details">[]>([]);const [error,setError]=useState("");const [busy,setBusy]=useState(true);const [more,setMore]=useState(false);const [page,setPage]=useState(0);
 const load=useCallback(async(nextPage=0)=>{setBusy(true);try{
  const {data:leaseRows,error:leaseError}=await readAllPages<Tables<"tenant_lease_details">>((from,to)=>supabase.from("tenant_lease_details").select("*",{count:"exact"}).order("lease_id").range(from,to));if(leaseError)throw leaseError;
  const activeLeases=(leaseRows??[]).filter(lease=>lease.status==="active");const ownerIds=[...new Set(activeLeases.map(lease=>lease.owner_id).filter((id):id is string=>!!id))];const propertyIds=[...new Set(activeLeases.map(lease=>lease.property_id).filter((id):id is string=>!!id))];
  const scope=`property_id.is.null${propertyIds.length?`,property_id.in.(${propertyIds.join(",")})`:""}`;
  const noticeRes=ownerIds.length?await supabase.from("announcements").select("*").in("owner_id",ownerIds).or(scope).order("created_at",{ascending:false}).order("id",{ascending:false}).range(nextPage*50,nextPage*50+49):{data:[],error:null};
  if(noticeRes.error)throw noticeRes.error;setNotices(previous=>nextPage===0?noticeRes.data:[...new Map([...previous,...noticeRes.data].map(row=>[row.id,row])).values()]);setLeases(leaseRows??[]);setMore(noticeRes.data.length===50);setPage(nextPage);setError("");
 }catch(e){setError(e instanceof Error?e.message:"Could not load notices.");}finally{setBusy(false);}},[]);

 useFocusEffect(useCallback(()=>{void load();},[load]));
 if(busy&&!notices.length&&!error)return <Loading/>;
 return <Screen><ScrollView contentContainerClassName="p-5 pb-12"><Button title="Back to my leases" variant="secondary" onPress={()=>router.replace("/tenant")}/><Text className="mb-5 mt-5 text-2xl font-bold text-slate-900">Building notices</Text>{error?<View className="mb-4"><Text accessibilityRole="alert" className="mb-2 text-red-700">{error}</Text><Button title="Retry" onPress={()=>void load(page)}/></View>:null}{!notices.length&&!error?<EmptyState title="No notices yet"/>:notices.map(notice=><Card key={notice.id}><Text className="mb-1 text-sm text-slate-500">{notice.property_id?leases.find(lease=>lease.property_id===notice.property_id)?.property_name??"Linked property":`${leases.find(lease=>lease.owner_id===notice.owner_id)?.landlord_name??"Landlord"} · All properties`}</Text><Text className="font-semibold text-slate-900">{notice.title}</Text>{notice.body?<Text className="mt-2 text-slate-700">{notice.body}</Text>:null}<Text className="mt-3 text-xs text-slate-500">{formatDate(notice.created_at)}</Text></Card>)}{more?<Button title="Load older notices" variant="secondary" onPress={()=>void load(page+1)} loading={busy}/>:null}</ScrollView></Screen>;
}
