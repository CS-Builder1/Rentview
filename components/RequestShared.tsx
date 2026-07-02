/**
 * Shared building blocks for maintenance-request detail screens —
 * used by both the tenant portal and the landlord inbox.
 */
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import { Image, Pressable, Text, TextInput, View } from "react-native";

import { Avatar } from "./Avatar";
import { Card, Icon } from "./ui";
import { openAttachment, signedUrl } from "../lib/attachments";
import type { Tables } from "../lib/database.types";
import { formatDate } from "../lib/format";
import { supabase } from "../lib/supabase";
import { useTheme } from "../lib/theme";

type RequestStatus = Tables<"maintenance_requests">["status"];
type Message = Tables<"request_messages">;

const TIMELINE: { status: RequestStatus; label: string }[] = [
  { status: "submitted", label: "Submitted" },
  { status: "acknowledged", label: "Seen by landlord" },
  { status: "in_progress", label: "Work in progress" },
  { status: "resolved", label: "Resolved" },
];

/** Vertical progress timeline for a request's lifecycle. */
export function StatusTimeline({ status }: { status: RequestStatus }) {
  const { colors } = useTheme();
  const currentIdx =
    status === "closed" ? TIMELINE.length - 1 : TIMELINE.findIndex((s) => s.status === status);

  return (
    <Card>
      {TIMELINE.map((step, i) => {
        const done = i <= currentIdx;
        const isLast = i === TIMELINE.length - 1;
        return (
          <View key={step.status} className="flex-row">
            <View className="items-center">
              <View
                className={`h-6 w-6 items-center justify-center rounded-full ${
                  done ? "bg-brand" : "bg-slate-200 dark:bg-slate-700"
                }`}
              >
                {done ? (
                  <Ionicons name="checkmark" size={14} color="#fff" />
                ) : (
                  <View className="h-2 w-2 rounded-full bg-slate-400 dark:bg-slate-500" />
                )}
              </View>
              {!isLast ? (
                <View
                  className={`w-0.5 flex-1 ${done && i < currentIdx ? "bg-brand" : "bg-slate-200 dark:bg-slate-700"}`}
                  style={{ minHeight: 18 }}
                />
              ) : null}
            </View>
            <Text
              className={`ml-3 pb-4 ${
                done
                  ? "font-medium text-slate-900 dark:text-slate-100"
                  : "text-slate-400 dark:text-slate-500"
              }`}
            >
              {step.label}
              {status === "closed" && isLast ? " (closed)" : ""}
            </Text>
          </View>
        );
      })}
    </Card>
  );
}

/** Thumbnail strip of a request's photos (tap to open full size). */
export function RequestPhotos({ requestId }: { requestId: string }) {
  const [photos, setPhotos] = useState<{ path: string; url: string }[]>([]);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase
        .from("request_photos")
        .select("storage_path")
        .eq("request_id", requestId)
        .order("created_at");
      if (!data || !active) return;
      const resolved = await Promise.all(
        data.map(async (p) => ({
          path: p.storage_path,
          url: (await signedUrl(p.storage_path)) ?? "",
        })),
      );
      if (active) setPhotos(resolved.filter((p) => p.url));
    })();
    return () => {
      active = false;
    };
  }, [requestId]);

  if (photos.length === 0) return null;

  return (
    <View className="mb-3 flex-row flex-wrap">
      {photos.map((p) => (
        <Pressable key={p.path} onPress={() => openAttachment(p.path)} className="mb-2 mr-2">
          <Image source={{ uri: p.url }} style={{ width: 84, height: 84, borderRadius: 12 }} />
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Message thread between tenant and landlord. Refetches on mount; the parent
 * screen's pull-to-refresh can bump `refreshKey` to reload.
 */
export function RequestThread({
  requestId,
  currentUserId,
  senderName,
  counterpartName,
  refreshKey = 0,
}: {
  requestId: string;
  currentUserId: string;
  senderName: string;
  counterpartName: string;
  refreshKey?: number;
}) {
  const { colors } = useTheme();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("request_messages")
      .select("*")
      .eq("request_id", requestId)
      .order("created_at");
    setMessages(data ?? []);
  }, [requestId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      const { error } = await supabase.from("request_messages").insert({
        request_id: requestId,
        sender_id: currentUserId,
        body,
      });
      if (!error) {
        setDraft("");
        await load();
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <Text className="mb-2 text-sm font-semibold uppercase text-slate-400 dark:text-slate-500">
        Messages
      </Text>
      {messages.length === 0 ? (
        <Text className="mb-2 text-slate-400 dark:text-slate-500">
          No messages yet — questions and updates land here.
        </Text>
      ) : (
        messages.map((m) => {
          const mine = m.sender_id === currentUserId;
          return (
            <View
              key={m.id}
              className={`mb-2 flex-row ${mine ? "justify-end" : "justify-start"}`}
            >
              {!mine ? (
                <View className="mr-2 mt-0.5">
                  <Avatar name={counterpartName} size="sm" />
                </View>
              ) : null}
              <View
                className={`max-w-[80%] rounded-2xl px-3 py-2 ${
                  mine
                    ? "rounded-br-md bg-brand"
                    : "rounded-bl-md bg-slate-100 dark:bg-slate-800"
                }`}
              >
                <Text className={mine ? "text-white" : "text-slate-800 dark:text-slate-200"}>
                  {m.body}
                </Text>
                <Text
                  className={`mt-0.5 text-[10px] ${
                    mine ? "text-brand-100" : "text-slate-400 dark:text-slate-500"
                  }`}
                >
                  {(mine ? senderName : counterpartName).split(" ")[0]} · {formatDate(m.created_at)}
                </Text>
              </View>
            </View>
          );
        })
      )}
      <View className="mt-1 flex-row items-center">
        <TextInput
          className="flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 dark:border-slate-700 dark:bg-surface-dark-raised dark:text-slate-100"
          placeholder="Write a message…"
          placeholderTextColor={colors.inkFaint}
          value={draft}
          onChangeText={setDraft}
          multiline
        />
        <Pressable
          onPress={send}
          disabled={sending || !draft.trim()}
          className={`ml-2 h-10 w-10 items-center justify-center rounded-full ${
            draft.trim() ? "bg-brand" : "bg-slate-200 dark:bg-slate-700"
          }`}
        >
          <Ionicons name="send" size={16} color={draft.trim() ? "#fff" : colors.inkFaint} />
        </Pressable>
      </View>
    </Card>
  );
}
