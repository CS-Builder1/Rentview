import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Image, ScrollView, Text, View } from "react-native";
import { Button, Card, Field, Loading, Screen } from "../../components/ui";
import { pickImageForUpload, uploadPickedImage, type PickedImage } from "../../lib/attachments";
import { cachedSelectResult } from "../../lib/cache";
import { useAuth } from "../../lib/auth";
import type { Tables } from "../../lib/database.types";
import { Constants } from "../../lib/database.types";
import { newRecordId } from "../../lib/id";
import { titleCase } from "../../lib/format";
import { operationError, readAllPages } from "../../lib/operationsQuery";
import { supabase } from "../../lib/supabase";

type Lease=Tables<"tenant_lease_details">;
type DraftPhoto={id:string;picked:PickedImage;uploaded:boolean};
export default function NewRequest(){
 const router=useRouter();const {session}=useAuth();
 const [leases,setLeases]=useState<Lease[]|null>(null);const [leaseId,setLeaseId]=useState<string|null>(null);const [title,setTitle]=useState("");const [description,setDescription]=useState("");const [availability,setAvailability]=useState("");const [access,setAccess]=useState("");const [contact,setContact]=useState("");const [category,setCategory]=useState<(typeof Constants.public.Enums.request_category)[number]>("general");const [urgency,setUrgency]=useState<(typeof Constants.public.Enums.wo_priority)[number]>("medium");const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [photos,setPhotos]=useState<DraftPhoto[]>([]);const [submittedId,setSubmittedId]=useState<string|null>(null);
 const requestId=useRef<string|null>(null);const attempted=useRef(false);
 const load=useCallback(async()=>{const snapshot=await cachedSelectResult<Lease[]>("tenant:activeLeases",readAllPages<Lease>((from,to)=>supabase.from("tenant_lease_details").select("*",{count:"exact"}).eq("status","active").order("lease_id").range(from,to)));setLeases(snapshot.data);if(snapshot.data?.length===1)setLeaseId(snapshot.data[0].lease_id);setError(snapshot.error?`${snapshot.stale?"Showing saved leases. Submission needs a connection. ":""}${snapshot.error}`:"");},[]);
 useFocusEffect(useCallback(()=>{void load();},[load]));
 async function pick(){if(photos.length>=5)return;setError("");setBusy(true);try{const picked=await pickImageForUpload();if(!picked)return;if(picked.base64.length>14_000_000)throw new Error("Choose a photo smaller than 10 MB.");setPhotos(previous=>[...previous,{id:newRecordId(),picked,uploaded:false}]);}catch(e){setError(e instanceof Error?e.message:"Could not read photo.");}finally{setBusy(false);}}
 async function uploadPhotos(id:string){
  const failed:string[]=[];const complete=new Set<string>();
  for(const photo of photos){if(photo.uploaded)continue;const path=`requests/${id}/${photo.id}.${photo.picked.ext}`;
   try{const {data:existing,error:readError}=await supabase.from("request_photos").select("id,storage_path").eq("id",photo.id).maybeSingle();if(readError)throw readError;if(existing){if(existing.storage_path!==path)throw new Error("Photo conflict. Add this photo again on the request.");complete.add(photo.id);continue;}
    try{await uploadPickedImage(path,photo.picked);}catch(uploadError){const code=String((uploadError as {statusCode?:string}).statusCode??"");if(code!=="409")throw uploadError;}
    const {error:writeError}=await supabase.from("request_photos").insert({id:photo.id,request_id:id,storage_path:path});if(writeError){if(writeError.code!=="23505")throw writeError;const {data:record,error:verifyError}=await supabase.from("request_photos").select("request_id,storage_path").eq("id",photo.id).single();if(verifyError||record?.request_id!==id||record.storage_path!==path)throw writeError;}complete.add(photo.id);
   }catch{failed.push(photo.id);}
  }
  setPhotos(previous=>previous.map(photo=>complete.has(photo.id)?{...photo,uploaded:true}:photo));
  if(failed.length){setError(`Your request was sent. ${failed.length} photo(s) could not upload. Retry below or open the request to add them later.`);return false;}return true;
 }
 async function submit(){if(busy)return;setError("");setBusy(true);
  try{
   if(submittedId){if(await uploadPhotos(submittedId))router.replace(`/tenant/request/${submittedId}`);return;}
   const lease=leases?.find(item=>item.lease_id===leaseId);if(!session||!lease?.lease_id||!lease.unit_id||!lease.property_id||!lease.owner_id)throw new Error("Choose your active unit before submitting.");if(title.trim().length<3)throw new Error("Describe the problem in a short title (at least 3 characters).");
   if(!requestId.current)requestId.current=newRecordId();const id=requestId.current;
   if(attempted.current){const {data:existing,error:readError}=await supabase.from("maintenance_requests").select("id").eq("id",id).maybeSingle();if(readError)throw readError;if(existing){setSubmittedId(existing.id);if(await uploadPhotos(existing.id))router.replace(`/tenant/request/${existing.id}`);return;}}
   const notes=[description.trim(),availability.trim()?`Visit availability: ${availability.trim()}`:"",access.trim()?`Access instructions: ${access.trim()}`:"",contact.trim()?`Preferred contact: ${contact.trim()}`:""].filter(Boolean).join("\n\n");
   if(notes.length>5000)throw new Error("Keep the combined details, visit availability, access instructions and contact preference under 5,000 characters.");
   attempted.current=true;
   const {data,error:writeError}=await supabase.from("maintenance_requests").insert({id,owner_id:lease.owner_id,lease_id:lease.lease_id,unit_id:lease.unit_id,property_id:lease.property_id,tenant_user_id:session.user.id,title:title.trim(),description:notes||null,category,urgency}).select("id").single();if(writeError)throw writeError;
   setSubmittedId(data.id);if(await uploadPhotos(data.id))router.replace(`/tenant/request/${data.id}`);
  }catch(e){setError(`${operationError(e)} Your draft is kept here; retry when connected.`);}finally{setBusy(false);}
 }
 if(!leases&&!error)return <Loading/>;
 return <Screen><ScrollView contentContainerClassName="mx-auto w-full max-w-2xl p-5 pb-12" keyboardShouldPersistTaps="handled"><Button title="Back" variant="secondary" disabled={busy} onPress={()=>router.canGoBack()?router.back():router.replace("/tenant")}/><Text className="mb-5 mt-5 text-2xl font-bold text-slate-900">Report a repair</Text>{error?<Text accessibilityRole="alert" accessibilityLiveRegion="polite" className="mb-4 text-red-700">{error}</Text>:null}
 {!leases?<Button title="Retry loading leases" onPress={()=>void load()}/>:!leases.length?<Card><Text className="mb-3 text-slate-600">You have no active linked lease. Ask your landlord for an invitation.</Text><Button title="Enter invite code" onPress={()=>router.push("/claim")}/></Card>:submittedId?<Card><Text className="mb-3 font-semibold text-slate-900">Your request has been sent.</Text><Text className="mb-4 text-slate-600">{photos.filter(p=>!p.uploaded).length} photo(s) still need upload. Keep this screen open to retry.</Text><Button title="Retry photo upload" onPress={submit} loading={busy}/><View className="mt-3"><Button title="Open request" variant="secondary" disabled={busy} onPress={()=>router.replace(`/tenant/request/${submittedId}`)}/></View></Card>:<>
 <Text className="mb-2 font-medium text-slate-700">Which property / unit?</Text><View className="mb-4 gap-2">{leases.map(lease=><Button key={lease.lease_id} title={`${leaseId===lease.lease_id?"✓ ":""}${[lease.property_name,lease.unit_label].filter(Boolean).join(" · ")}`} variant={leaseId===lease.lease_id?"primary":"secondary"} disabled={busy} onPress={()=>setLeaseId(lease.lease_id)}/>)}</View>
 <Field label="What's wrong" value={title} onChangeText={setTitle} maxLength={200} placeholder="e.g. Kitchen tap is leaking"/><Field label="Details" value={description} onChangeText={setDescription} multiline maxLength={5000} placeholder="When it started and what you've noticed"/>
 <Text className="mb-2 font-medium text-slate-700">Category</Text><View className="mb-4 flex-row flex-wrap gap-2">{Constants.public.Enums.request_category.map(value=><Button key={value} title={titleCase(value)} variant={category===value?"primary":"secondary"} onPress={()=>setCategory(value)} disabled={busy}/>)}</View>
 <Text className="mb-2 font-medium text-slate-700">How urgent?</Text><View className="mb-3 flex-row flex-wrap gap-2">{Constants.public.Enums.wo_priority.map(value=><Button key={value} title={titleCase(value)} variant={urgency===value?"primary":"secondary"} onPress={()=>setUrgency(value)} disabled={busy}/>)}</View><Text className="mb-4 text-sm text-slate-500">Low: minor inconvenience · Medium: repair needed · High: significant disruption · Urgent: immediate risk or loss of essential service.</Text>{urgency==="urgent"?<Card><Text className="text-red-700">For immediate danger, contact local emergency services or the emergency contact supplied by your landlord. A repair request does not guarantee an immediate response.</Text></Card>:null}
 <Field label="When can someone visit? (optional)" value={availability} onChangeText={setAvailability} maxLength={500} placeholder="e.g. Weekdays after 4pm"/><Field label="Access instructions / permission (optional)" value={access} onChangeText={setAccess} maxLength={1000} multiline placeholder="Explain how access should be arranged; avoid door codes here."/><Field label="Preferred contact (optional)" value={contact} onChangeText={setContact} maxLength={300} placeholder="e.g. Message me here to arrange a visit"/>
 <Text className="mb-2 font-medium text-slate-700">Photos ({photos.length}/5)</Text><View className="mb-3 flex-row flex-wrap">{photos.map((photo,index)=><View key={photo.id} className="mb-3 mr-3"><Image accessibilityLabel={`Selected photo ${index+1}`} source={{uri:`data:${photo.picked.contentType};base64,${photo.picked.base64}`}} className="h-24 w-24 rounded-xl"/><Button title={`Remove photo ${index+1}`} variant="secondary" disabled={busy} onPress={()=>setPhotos(previous=>previous.filter(p=>p.id!==photo.id))}/></View>)}</View><Button title="Add photo" variant="secondary" onPress={pick} disabled={busy||photos.length>=5}/><View className="mt-5"><Button title="Submit request" onPress={submit} loading={busy}/></View><Text className="mt-3 text-sm text-slate-500">Your landlord receives the request first. If a photo upload fails, your request stays sent and you can retry the photo.</Text>
 </>}
 </ScrollView></Screen>;
}
