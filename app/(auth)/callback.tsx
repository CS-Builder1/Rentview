import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import { Button, Loading, Screen } from "../../components/ui";
import { clearAuthDestination, pendingAuthDestination } from "../../lib/authDestination";
import { authDestination, safeReturnPath } from "../../lib/invites";
import { exchangeAuthCodeOnce } from "../../lib/oauth";
import { supabase } from "../../lib/supabase";

export default function AuthCallback() {
  const params=useLocalSearchParams<{code?:string;next?:string;intent?:string;error_description?:string;error?:string}>();
  const router=useRouter();
  const [error,setError]=useState("");
  useEffect(()=>{
    let active=true;
    void(async()=>{
      try {
        if(params.error_description || params.error) throw new Error(params.error_description || params.error);
        const initialized = await supabase.auth.initialize();
        if (initialized.error) throw initialized.error;
        // Web Supabase initialization already exchanges the PKCE code in the URL.
        // Native deep links need an explicit exchange (never accept implicit tokens).
        if(Platform.OS!=="web" && params.code) await exchangeAuthCodeOnce(params.code);
        const {data,error:sessionError}=await supabase.auth.getSession();
        if(sessionError) throw sessionError;
        if(!data.session) throw new Error("This link expired or was opened in another browser. Request a new link and open it on the device where you started.");
        const saved=await pendingAuthDestination();
        const next=authDestination(params.next,saved);
        // Keep an invitation until the lease claim itself succeeds. A recovery
        // link or provider callback only proves sign-in, not portal membership.
        if (!next.startsWith("/claim")) await clearAuthDestination();
        if(active) router.replace(params.intent==="recovery" ? {pathname:"/reset-password",params:{next}} as never : next as never);
      } catch(e) { if(active) setError(e instanceof Error?e.message:"Could not complete sign-in."); }
    })();
    return()=>{active=false;};
  },[params.code,params.next,params.intent,params.error,params.error_description,router]);
  if(!error) return <Loading/>;
  return <Screen><View className="p-6"><Text className="mb-3 text-xl font-bold text-slate-900">Link unavailable</Text><Text accessibilityRole="alert" className="mb-5 text-red-700">{error}</Text><Button title="Return to sign in" onPress={()=>router.replace({pathname:"/(auth)/login",params:{next:safeReturnPath(params.next)}} as never)}/></View></Screen>;
}
