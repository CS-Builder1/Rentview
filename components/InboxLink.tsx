import { useRouter, type Href } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { useInboxRefresh } from "../lib/useInboxRefresh";
import { Button } from "./ui";

export function InboxLink() {
  const router = useRouter();
  const uid = useAuth().session?.user.id;
  const [count, setCount] = useState<{uid: string; unread: number} | null>(null);
  useInboxRefresh(useCallback(async current => {
    if (!uid) return;
    const { data, error } = await supabase.rpc("inbox_unread_count");
    if (current()) setCount(error ? null : {uid, unread: data ?? 0});
  }, [uid]), 20000);
  const unread = count?.uid === uid ? count?.unread : 0;
  return <View className="mb-4"><Button title={unread ? `Inbox · ${unread} unread` : "Inbox"} variant="secondary" onPress={() => router.push("/inbox" as Href)} /></View>;
}
