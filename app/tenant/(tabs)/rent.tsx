import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { Button, Card, EmptyState, Loading, Screen } from "../../../components/ui";
import { cachedSelectResult } from "../../../lib/cache";
import { readAllPages } from "../../../lib/operationsQuery";
import type { Tables } from "../../../lib/database.types";
import { formatCurrency, formatDate, titleCase } from "../../../lib/format";
import { rentRemaining, rentState, rentSummaryResult } from "../../../lib/tenantRent";
import { supabase } from "../../../lib/supabase";

type Lease = Tables<"tenant_lease_details">;
const STATES={paid:"Paid",overdue:"Overdue",due:"Due today",upcoming:"Upcoming",unscheduled:"Unpaid · no due date"};
export default function TenantRent(){
 const [payments,setPayments]=useState<Tables<"rent_record_balances">[]|null>(null);const [leases,setLeases]=useState<Lease[]>([]);const [error,setError]=useState("");const [refreshing,setRefreshing]=useState(false);
 const load=useCallback(async()=>{
  setRefreshing(true);
  const snapshot=await cachedSelectResult<{payments:Tables<"rent_record_balances">[];leases:Lease[]}>("tenant:rent-balances",(async()=>{
   const leaseRes=await readAllPages<Lease>((from,to)=>supabase.from("tenant_lease_details").select("*",{count:"exact"}).order("lease_id").range(from,to));if(leaseRes.error)return{data:null,error:leaseRes.error};
   const leaseIds=(leaseRes.data??[]).map(lease=>lease.lease_id).filter((id):id is string=>!!id);
   const paymentRes=leaseIds.length?await readAllPages<Tables<"rent_record_balances">>((from,to)=>supabase.from("rent_record_balances").select("*",{count:"exact"}).in("lease_id",leaseIds).order("due_date",{ascending:false,nullsFirst:false}).order("id",{ascending:false}).range(from,to)):{data:[],error:null};
   if(paymentRes.error)return{data:null,error:paymentRes.error};return{data:{payments:paymentRes.data??[],leases:leaseRes.data??[]},error:null};
  })());
  setPayments(snapshot.data?.payments??null);setLeases(snapshot.data?.leases??[]);setError(snapshot.error?`${snapshot.stale?"Showing saved records. ":""}${snapshot.error}`:"");setRefreshing(false);
 },[]);

 useFocusEffect(useCallback(()=>{void load();},[load]));
 const locations=useMemo(()=>new Map(leases.map(lease=>[lease.lease_id,[lease.property_name,lease.unit_label].filter(Boolean).join(" · ")])),[leases]);
 const summary=useMemo(()=>rentSummaryResult(payments??[]),[payments]);
 const location=(id:string)=>locations.get(id)??"Linked lease";
 if(!payments&&!error)return <Loading/>;
 return <Screen><FlatList
  data={payments??[]}
  keyExtractor={payment=>payment.id}
  contentContainerStyle={{paddingHorizontal:20,paddingBottom:40}}
  refreshing={refreshing}
  onRefresh={()=>void load()}
  initialNumToRender={12}
  maxToRenderPerBatch={12}
  windowSize={7}
  ListHeaderComponent={<View>
   <Text className="mb-1 mt-2 text-2xl font-bold text-slate-900">Rent records</Text>
   <Text className="mb-5 text-slate-500">What your landlord has recorded. Pay using the method agreed with them — RentView does not collect rent. Ask your landlord to correct an inaccurate record.</Text>
   {error?<View className="mb-4"><Text accessibilityRole="alert" className="mb-2 text-red-700">{error}</Text><Button title="Retry" variant="secondary" onPress={()=>void load()}/></View>:null}
   {summary.error && <Text accessibilityRole="alert" className="text-red-700">{summary.error}</Text>}
   {summary.groups.map(group=><Card key={`${group.leaseId}:${group.currency}`}><Text className="font-semibold text-slate-900">{location(group.leaseId)} · {group.currency}</Text>{(["overdue","due","upcoming","unscheduled"] as const).map(key=>group[key]!==0?<View key={key} className="mt-2 flex-row justify-between"><Text className={key==="overdue"?"text-red-700":"text-slate-600"}>{STATES[key]}</Text><Text className="font-semibold text-slate-800">{formatCurrency(group[key],group.currency)}</Text></View>:null)}</Card>)}
  </View>}
  ListEmptyComponent={payments?<EmptyState title="Nothing recorded yet" subtitle="Payments your landlord logs will show up here."/>:null}
  renderItem={({item:payment})=><Card>
   <Text className="mb-2 text-sm text-slate-500">{location(payment.lease_id)}</Text>
   <View className="flex-row justify-between"><Text className="text-base font-semibold text-slate-900">{formatCurrency(payment.amount,payment.currency)}</Text><Text className={rentState(payment)==="overdue"?"text-red-700":payment.paid_on?"text-green-700":"text-slate-600"}>{STATES[rentState(payment)]}</Text></View>
   <Text className="mt-1 text-slate-500">{payment.paid_on?`Paid ${formatDate(payment.paid_on)}`:payment.due_date?`Due ${formatDate(payment.due_date)}`:"No due date"}{payment.method?` · ${titleCase(payment.method)}`:""}</Text>
   {!payment.paid_on && <Text className="mt-1 font-medium text-slate-700">{rentRemaining(payment) === 0 ? "Paid in full" : formatCurrency(rentRemaining(payment),payment.currency) + " remaining"}</Text>}
   {payment.applied_amount > 0 && <Text className="mt-1 text-slate-500">{formatCurrency(payment.applied_amount,payment.currency)} applied</Text>}
   {payment.note?<Text className="mt-1 text-sm text-slate-500">{payment.note}</Text>:null}
  </Card>}
 /></Screen>;
}
