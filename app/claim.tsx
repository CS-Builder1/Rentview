import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Button, Card, Field, Loading, Screen } from "../components/ui";
import { useAuth } from "../lib/auth";
import { clearAuthDestination, rememberAuthDestination } from "../lib/authDestination";
import { claimPath, normalizeInviteCode } from "../lib/invites";
import { supabase } from "../lib/supabase";
import { operationError } from "../lib/operationsQuery";

export default function ClaimInvite() {
 const router=useRouter();const params=useLocalSearchParams<{code?:string}>();
 const {session,initializing,refreshProfile}=useAuth();
 const [code,setCode]=useState(typeof params.code==="string"?params.code:"");const [busy,setBusy]=useState(false);const [error,setError]=useState("");
 useEffect(()=>{if(typeof params.code==="string")setCode(params.code);},[params.code]);
 async function join(){
  const valid=normalizeInviteCode(code);setError("");if(!valid){setError("Enter the 6–64 letter/number code supplied by your landlord.");return;}
  setBusy(true);try{
   if(!session){const next=claimPath(valid);await rememberAuthDestination(next);router.push({pathname:"/(auth)/login",params:{next}} as never);return;}
   const {error:claimError}=await supabase.rpc("claim_tenant_invite",{invite_code:valid});if(claimError)throw claimError;
   await clearAuthDestination();await refreshProfile();router.replace("/tenant");
  }catch(e){setError(operationError(e));}finally{setBusy(false);}
 }
 if(initializing)return <Loading/>;
 return <Screen><View className="flex-row items-center px-4 py-2"><Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={()=>router.canGoBack()?router.back():router.replace("/")} className="p-2"><Ionicons name="chevron-back" size={24} color="#0f766e"/></Pressable><Text className="flex-1 text-xl font-bold text-slate-900">Join your landlord</Text></View><ScrollView contentContainerClassName="mx-auto w-full max-w-lg px-5 pb-10" keyboardShouldPersistTaps="handled"><Card><Text className="text-slate-700">Use the invitation from your landlord to link your lease. Then report repairs, see progress, and view recorded rent payments.</Text><Text className="mt-2 text-sm text-slate-500">Invitations are single-use and expire. If yours is unavailable, ask your landlord for a new one. Use the email address they invited.</Text></Card><Field label="Invite code" value={code} onChangeText={value=>setCode(value.toUpperCase())} placeholder="ABCD1234" autoCapitalize="characters" autoCorrect={false} maxLength={64} onSubmitEditing={join}/>{error?<Text accessibilityRole="alert" accessibilityLiveRegion="polite" className="mb-3 text-red-700">{error}</Text>:null}<Button title={session?"Join lease":"Continue to sign in or create account"} onPress={join} loading={busy}/>{session?<Text className="mt-4 text-center text-xs text-slate-500">Signed in as {session.user.email}</Text>:<Text className="mt-4 text-slate-500">Your code stays with you through sign-in and email confirmation.</Text>}</ScrollView></Screen>;
}
