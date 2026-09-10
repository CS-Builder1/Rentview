import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  pickImageForUpload,
  signedUrl,
  uploadPickedImage,
} from "../lib/attachments";
import { useAuth } from "../lib/auth";
import type { Tables } from "../lib/database.types";
import { notifyPush } from "../lib/push";
import { supabase } from "../lib/supabase";

type Photo = { id: string; path: string; url: string | null };

function notify(title: string, message: string) {
  Platform.OS === "web"
    ? window.alert(`${title}\n\n${message}`)
    : Alert.alert(title, message);
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

/**
 * Photos + message thread for one maintenance request. Both participants
 * (owner and tenant) see and post to the same thread; RLS scopes every read
 * and write to the request they belong to, so this component is identical on
 * both sides.
 */
export function RequestConversation({
  requestId,
  locked = false,
}: {
  requestId: string;
  /** Closed requests keep their history but stop accepting new posts. */
  locked?: boolean;
}) {
  const { session } = useAuth();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [messages, setMessages] = useState<Tables<"request_messages">[]>([]);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    const [photoRes, messageRes] = await Promise.all([
      supabase
        .from("request_photos")
        .select("*")
        .eq("request_id", requestId)
        .order("created_at", { ascending: false }),
      supabase
        .from("request_messages")
        .select("*")
        .eq("request_id", requestId)
        .order("created_at", { ascending: true }),
    ]);

    const resolved = await Promise.all(
      (photoRes.data ?? []).map(async (p) => ({
        id: p.id,
        path: p.storage_path,
        url: await signedUrl(p.storage_path).catch(() => null),
      })),
    );
    setPhotos(resolved);
    setMessages(messageRes.data ?? []);
  }, [requestId]);

  useEffect(() => {
    load();
  }, [load]);

  async function addPhoto() {
    if (!session) return;
    try {
      const picked = await pickImageForUpload();
      if (!picked) return;
      setUploading(true);
      // The storage policy keys request photos on `requests/<id>/…` so both
      // participants can read them — not on the uploader's own uid folder.
      const storagePath = `requests/${requestId}/${Date.now()}.${picked.ext}`;
      await uploadPickedImage(storagePath, picked);
      const { error } = await supabase
        .from("request_photos")
        .insert({ request_id: requestId, storage_path: storagePath });
      if (error) throw error;
      await load();
    } catch (e) {
      notify("Could not add photo", e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  async function send() {
    const text = body.trim();
    if (!text || !session) return;
    setSending(true);
    const { error } = await supabase.from("request_messages").insert({
      request_id: requestId,
      sender_id: session.user.id,
      body: text,
    });
    setSending(false);
    if (error) {
      notify("Could not send", error.message);
      return;
    }
    notifyPush("request_message", requestId, text);
    setBody("");
    load();
  }

  return (
    <View>
      <View className="mb-2 mt-4 flex-row items-center justify-between">
        <Text className="text-lg font-semibold text-slate-900">
          Photos ({photos.length})
        </Text>
        {locked ? null : (
          <Pressable
            onPress={addPhoto}
            disabled={uploading}
            className={`flex-row items-center rounded-full bg-brand px-3 py-1.5 ${
              uploading ? "opacity-50" : ""
            }`}
          >
            {uploading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Ionicons name="camera-outline" color="#fff" size={16} />
            )}
            <Text className="ml-1 font-semibold text-white">Add</Text>
          </Pressable>
        )}
      </View>

      {photos.length === 0 ? (
        <Text className="mb-2 text-slate-400">No photos yet.</Text>
      ) : (
        <View className="mb-2 flex-row flex-wrap">
          {photos.map((p) =>
            p.url ? (
              <Image
                key={p.id}
                source={{ uri: p.url }}
                className="mb-2 mr-2 h-24 w-24 rounded-xl"
              />
            ) : (
              <View
                key={p.id}
                className="mb-2 mr-2 h-24 w-24 items-center justify-center rounded-xl bg-slate-200"
              >
                <Ionicons name="image-outline" size={20} color="#94a3b8" />
              </View>
            ),
          )}
        </View>
      )}

      <Text className="mb-2 mt-4 text-lg font-semibold text-slate-900">
        Messages
      </Text>
      {messages.length === 0 ? (
        <Text className="mb-2 text-slate-400">
          No messages yet. Anything posted here is visible to both sides.
        </Text>
      ) : (
        messages.map((m) => {
          const mine = m.sender_id === session?.user.id;
          return (
            <View
              key={m.id}
              className={`mb-2 max-w-[85%] rounded-2xl px-3 py-2 ${
                mine ? "self-end bg-brand" : "self-start bg-white border border-slate-200"
              }`}
            >
              <Text className={mine ? "text-white" : "text-slate-800"}>
                {m.body}
              </Text>
              <Text
                className={`mt-1 text-[10px] ${
                  mine ? "text-teal-100" : "text-slate-400"
                }`}
              >
                {timeLabel(m.created_at)}
              </Text>
            </View>
          );
        })
      )}

      {locked ? (
        <Text className="mt-2 text-xs text-slate-400">
          This request is closed. Reopen it to continue the conversation.
        </Text>
      ) : (
        <View className="mt-2 flex-row items-end">
          <TextInput
            className="mr-2 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-3 text-slate-900"
            placeholder="Write a message…"
            placeholderTextColor="#94a3b8"
            value={body}
            onChangeText={setBody}
            multiline
          />
          <Pressable
            onPress={send}
            disabled={sending || !body.trim()}
            className={`h-12 w-12 items-center justify-center rounded-xl bg-brand ${
              sending || !body.trim() ? "opacity-50" : ""
            }`}
          >
            {sending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Ionicons name="send" size={18} color="#fff" />
            )}
          </Pressable>
        </View>
      )}
    </View>
  );
}
