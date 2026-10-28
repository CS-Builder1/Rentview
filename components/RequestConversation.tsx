import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Image, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { pickImageForUpload, signedUrl, uploadPickedImage } from "../lib/attachments";
import { useAuth } from "../lib/auth";
import type { Tables } from "../lib/database.types";
import { supabase } from "../lib/supabase";
import { newRecordId } from "../lib/id";
import { Button } from "./ui";

type Photo={id:string;url:string|null};
type Message=Tables<"request_messages">;
function timeLabel(value:string){const d=new Date(value);return Number.isNaN(d.getTime())?"":new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(d);}
function mergeMessages(previous:Message[],next:Message[]){return [...new Map([...previous,...next].map(m=>[m.id,m])).values()].sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));}


export function RequestConversation({requestId,locked=false}:{requestId:string;locked?:boolean}){
 const {session}=useAuth();const uid=session?.user.id;
 const [photos,setPhotos]=useState<Photo[]>([]);const [messages,setMessages]=useState<Message[]>([]);const [body,setBody]=useState("");const [sending,setSending]=useState(false);const [uploading,setUploading]=useState(false);const [loading,setLoading]=useState(true);const [error,setError]=useState("");const [previewId,setPreviewId]=useState<string|null>(null);const [older,setOlder]=useState(false);const [hasOlder,setHasOlder]=useState(false);const [unread,setUnread]=useState(0);
 const preview=photos.find(photo=>photo.id===previewId)?.url??null;
 const identity=useRef("");const key=`${requestId}:${uid??""}`;identity.current=key;
 const generation=useRef(0);const inflight=useRef(false);const messageIds=useRef(new Set<string>());const mounted=useRef(true);const pendingMessage=useRef<{id:string;body:string}|null>(null);const sendLock=useRef(false);
 const load=useCallback(async()=>{
  if(!uid||inflight.current||identity.current!==key)return;inflight.current=true;const ticket=generation.current;
  try{
   const [requestRes,photoRes,messageRes]=await Promise.all([
    supabase.from("maintenance_requests").select("id").eq("id",requestId).maybeSingle(),
    supabase.from("request_photos").select("*").eq("request_id",requestId).order("created_at",{ascending:false}).limit(100),
    supabase.from("request_messages").select("*").eq("request_id",requestId).order("created_at",{ascending:false}).order("id",{ascending:false}).limit(100),
   ]);
   if(!mounted.current||ticket!==generation.current||identity.current!==key)return;
   if(requestRes.error)throw requestRes.error;
   if(!requestRes.data){setMessages([]);setPhotos([]);setPreviewId(null);setBody("");throw new Error("This request is no longer available to this account.");}
   if(photoRes.error)throw photoRes.error;if(messageRes.error)throw messageRes.error;
   const resolved=await Promise.all(photoRes.data.map(async p=>({id:p.id,url:await signedUrl(p.storage_path,60)})));
   if(!mounted.current||ticket!==generation.current||identity.current!==key)return;
   const fresh=messageRes.data;const newReplies=fresh.filter(m=>!messageIds.current.has(m.id)&&m.sender_id!==uid);
   if(messageIds.current.size>0&&newReplies.length)setUnread(n=>n+newReplies.length);
   if(messageIds.current.size===0)setHasOlder(fresh.length===100);fresh.forEach(m=>messageIds.current.add(m.id));setMessages(previous=>mergeMessages(previous,fresh));setPhotos(resolved);setError("");
  }catch(e){if(mounted.current&&ticket===generation.current&&identity.current===key)setError(e instanceof Error?e.message:"Conversation could not refresh. Check your connection and retry.");}
  finally{if(ticket===generation.current){inflight.current=false;if(mounted.current&&identity.current===key)setLoading(false);}}
 },[requestId,uid,key]);
 useEffect(()=>{
  mounted.current=true;generation.current+=1;inflight.current=false;sendLock.current=false;setLoading(true);setSending(false);setUploading(false);setMessages([]);setPhotos([]);setBody("");setPreviewId(null);setUnread(0);setHasOlder(false);setOlder(false);setError("");messageIds.current.clear();pendingMessage.current=null;
  void load();const interval=setInterval(()=>{if(AppState.currentState==="active")void load();},12000);
  const foreground=AppState.addEventListener("change",state=>{if(state==="active")void load();});
  const channel=supabase.channel(`conversation:${requestId}:${uid}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"request_messages",filter:`request_id=eq.${requestId}`},()=>void load()).on("postgres_changes",{event:"INSERT",schema:"public",table:"request_photos",filter:`request_id=eq.${requestId}`},()=>void load()).subscribe();
  return()=>{mounted.current=false;generation.current+=1;clearInterval(interval);foreground.remove();void supabase.removeChannel(channel);};
 },[load,requestId,uid]);
 async function loadOlder(){
  const first=messages[0];if(!first||older||identity.current!==key)return;setOlder(true);const ticket=generation.current;
  try{
   const {data,error:readError}=await supabase.from("request_messages").select("*").eq("request_id",requestId).or(`created_at.lt.${first.created_at},and(created_at.eq.${first.created_at},id.lt.${first.id})`).order("created_at",{ascending:false}).order("id",{ascending:false}).limit(100);
   if(readError)throw readError;if(ticket!==generation.current||!mounted.current||identity.current!==key)return;setMessages(previous=>mergeMessages(previous,data));data.forEach(m=>messageIds.current.add(m.id));setHasOlder(data.length===100);
  }catch(e){if(identity.current===key)setError(e instanceof Error?e.message:"Could not load older messages.");}finally{if(identity.current===key)setOlder(false);}
 }
 async function addPhoto(){if(!uid||locked||uploading||identity.current!==key)return;setError("");setUploading(true);try{const picked=await pickImageForUpload();if(!picked||identity.current!==key)return;const path=`requests/${requestId}/${newRecordId()}.${picked.ext}`;await uploadPickedImage(path,picked);const {error:writeError}=await supabase.from("request_photos").insert({request_id:requestId,storage_path:path});if(writeError)throw writeError;await load();}catch(e){if(identity.current===key)setError(e instanceof Error?e.message:"Could not add photo. Try again.");}finally{if(identity.current===key)setUploading(false);}}
 async function send(){const text=body.trim();if(!uid||!text||locked||sendLock.current||identity.current!==key)return;if(text.length>5000){setError("Keep messages under 5,000 characters.");return;}sendLock.current=true;setError("");setSending(true);
  // Preserve the ID on retry after a lost response. A duplicate is accepted only
  // after reading back the same sender/body under RLS.
  if(pendingMessage.current?.body!==text)pendingMessage.current={id:newRecordId(),body:text};const pending=pendingMessage.current;
  try{const {data:written,error:writeError}=await supabase.from("request_messages").insert({id:pending.id,request_id:requestId,sender_id:uid,body:text}).select("*").single();let saved=written;if(writeError){if(writeError.code!=="23505")throw writeError;const {data,error:readError}=await supabase.from("request_messages").select("*").eq("id",pending.id).single();if(readError||data?.sender_id!==uid||data.body!==text||data.request_id!==requestId)throw writeError;saved=data;}if(identity.current!==key||!mounted.current)return;if(saved){const row=saved;messageIds.current.add(row.id);setMessages(previous=>mergeMessages(previous,[row]));}setBody(previous=>previous.trim()===text?"":previous);pendingMessage.current=null;setUnread(0);await load();}catch(e){if(identity.current===key)setError(e instanceof Error?e.message:"Message not sent. Your text is kept; retry when connected.");}finally{if(identity.current===key){sendLock.current=false;setSending(false);}}}
 return <View>
  {error?<View className="mt-4 rounded-xl bg-red-50 p-3"><Text accessibilityRole="alert" accessibilityLiveRegion="polite" className="mb-2 text-red-700">{error}</Text><Button title="Refresh conversation" variant="secondary" onPress={()=>void load()}/></View>:null}
  {loading?<ActivityIndicator accessibilityLabel="Loading conversation" className="mt-4"/>:null}
  <View className="mb-2 mt-4 flex-row items-center justify-between"><Text className="text-lg font-semibold text-slate-900">Photos ({photos.length})</Text>{!locked?<Button title={uploading?"Uploading…":"Add photo"} variant="secondary" onPress={addPhoto} loading={uploading}/>:null}</View>
  {photos.length===100?<Text className="mb-2 text-xs text-slate-500">Showing the 100 most recent photos.</Text>:null}
  {!loading&&!photos.length?<Text className="mb-2 text-slate-500">No photos yet.</Text>:null}<View className="flex-row flex-wrap">{photos.map((photo,index)=>photo.url?<Pressable accessibilityRole="button" accessibilityLabel={`Open repair photo ${index+1}`} key={photo.id} onPress={()=>setPreviewId(photo.id)} className="mb-2 mr-2"><Image accessibilityLabel={`Repair photo ${index+1}`} source={{uri:photo.url}} className="h-24 w-24 rounded-xl"/></Pressable>:<Text key={photo.id} className="mr-2 text-slate-500">Photo unavailable. Refresh to retry.</Text>)}</View>
  <View className="mb-2 mt-4 flex-row items-center justify-between"><Text className="text-lg font-semibold text-slate-900">Messages</Text><Pressable accessibilityRole="button" onPress={()=>{setUnread(0);void load();}} className="p-2"><Text className="text-brand">{unread?`${unread} new ${unread===1?"reply":"replies"} · Mark read`:"Refresh"}</Text></Pressable></View>
  {hasOlder?<Button title="Load older messages" variant="secondary" onPress={loadOlder} loading={older}/>:null}
  {!loading&&!messages.length?<Text className="mb-2 text-slate-500">No messages yet. Both you and your landlord can read this conversation.</Text>:null}
  {messages.map(message=>{const mine=message.sender_id===uid;return <View key={message.id} className={`mb-2 max-w-[90%] rounded-2xl px-3 py-2 ${mine?"self-end bg-brand":"self-start border border-slate-200 bg-white"}`}><Text className={mine?"text-white":"text-slate-800"}>{message.body}</Text><Text className={`mt-1 text-xs ${mine?"text-teal-100":"text-slate-500"}`}>{mine?"You":"Other participant"} · {timeLabel(message.created_at)}</Text></View>;})}
  {locked?<Text className="mt-2 text-sm text-slate-500">This request is closed. Use “Still not fixed” above if the repair needs more work.</Text>:<View className="mt-2 flex-row items-end"><TextInput accessibilityLabel="Message to the other participant" className="mr-2 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-3 text-slate-900" placeholder="Write a message…" value={body} onChangeText={setBody} maxLength={5000} multiline/><Pressable accessibilityRole="button" accessibilityLabel="Send message" accessibilityState={{disabled:sending||!body.trim(),busy:sending}} onPress={send} disabled={sending||!body.trim()} className={`h-12 w-12 items-center justify-center rounded-xl bg-brand ${sending||!body.trim()?"opacity-50":""}`}>{sending?<ActivityIndicator color="#fff"/>:<Ionicons name="send" size={18} color="#fff"/>}</Pressable></View>}
  <Modal visible={!!preview} transparent animationType="fade" onRequestClose={()=>setPreviewId(null)}><View className="flex-1 bg-slate-950 p-5"><View className="mb-4 mt-8"><Button title="Close photo" variant="secondary" onPress={()=>setPreviewId(null)}/></View><ScrollView maximumZoomScale={5} minimumZoomScale={1} contentContainerStyle={{flexGrow:1}}>{preview?<Image accessibilityLabel="Full repair photo" resizeMode="contain" source={{uri:preview}} style={{width:"100%",height:650}}/>:null}</ScrollView><Text className="mb-4 text-center text-white">Pinch to zoom on supported devices. Use browser zoom on web.</Text></View></Modal>
 </View>;
}
