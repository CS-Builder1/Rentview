import { Ionicons } from "@expo/vector-icons";
import {
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { RequestConversation } from "../../../components/RequestConversation";
import {
  Badge,
  Button,
  Card,
  Field,
  Loading,
  Screen,
} from "../../../components/ui";
import { cachedSelect } from "../../../lib/cache";
import type { Tables } from "../../../lib/database.types";
import { formatDate, titleCase } from "../../../lib/format";
import { notifyPush } from "../../../lib/push";
import { supabase } from "../../../lib/supabase";

const STATUS_COPY: Record<string, string> = {
  submitted: "Sent to your landlord. Waiting for them to look at it.",
  acknowledged: "Your landlord has seen this and is arranging the work.",
  in_progress: "Work is underway.",
  resolved: "Marked as fixed. Let your landlord know if it isn't.",
  closed: "This request is closed.",
};

function notify(title: string, message: string) {
  Platform.OS === "web"
    ? window.alert(`${title}\n\n${message}`)
    : Alert.alert(title, message);
}

export default function TenantRequestDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [request, setRequest] = useState<Tables<"maintenance_requests"> | null>(
    null,
  );
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const data = await cachedSelect<Tables<"maintenance_requests">>(
      `tenant:request:${id}`,
      supabase.from("maintenance_requests").select("*").eq("id", id).single(),
    );
    setRequest(data ?? null);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function submitRating() {
    if (!request || rating === 0) return;
    setBusy(true);
    const { error } = await supabase
      .from("maintenance_requests")
      .update({ rating, rating_comment: comment.trim() || null })
      .eq("id", request.id);
    setBusy(false);
    if (error) {
      notify("Could not save", error.message);
      return;
    }
    setComment("");
    load();
  }

  async function closeRequest() {
    if (!request) return;
    setBusy(true);
    const { error } = await supabase
      .from("maintenance_requests")
      .update({ status: "closed" })
      .eq("id", request.id);
    setBusy(false);
    if (error) {
      notify("Could not close", error.message);
      return;
    }
    notifyPush("request_updated", request.id);
    load();
  }

  if (!request) return <Loading />;

  const canRate =
    (request.status === "resolved" || request.status === "closed") &&
    request.rating == null;

  return (
    <Screen>
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/tenant/requests")
          }
          className="p-2"
        >
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text className="flex-1 text-xl font-bold text-slate-900" numberOfLines={1}>
          Request
        </Text>
      </View>

      <ScrollView
        contentContainerClassName="px-5 pb-10"
        keyboardShouldPersistTaps="handled"
      >
        <Card>
          <View className="flex-row items-start justify-between">
            <Text className="flex-1 pr-2 text-xl font-bold text-slate-900">
              {request.title}
            </Text>
            <Badge label={request.status} />
          </View>
          {request.description ? (
            <Text className="mt-2 text-slate-600">{request.description}</Text>
          ) : null}
          <Text className="mt-3 text-slate-500">
            {STATUS_COPY[request.status] ?? ""}
          </Text>
          <Text className="mt-2 text-xs text-slate-400">
            {titleCase(request.category)} · {titleCase(request.urgency)} urgency ·
            reported {formatDate(request.created_at)}
          </Text>
        </Card>

        {request.rating != null ? (
          <Card>
            <Text className="text-sm font-semibold uppercase text-slate-400">
              Your rating
            </Text>
            <View className="mt-1 flex-row">
              {[1, 2, 3, 4, 5].map((n) => (
                <Ionicons
                  key={n}
                  name={n <= (request.rating ?? 0) ? "star" : "star-outline"}
                  size={20}
                  color="#f59e0b"
                />
              ))}
            </View>
            {request.rating_comment ? (
              <Text className="mt-2 text-slate-600">{request.rating_comment}</Text>
            ) : null}
          </Card>
        ) : null}

        {canRate ? (
          <Card>
            <Text className="text-base font-semibold text-slate-900">
              How did it go?
            </Text>
            <View className="mt-2 flex-row">
              {[1, 2, 3, 4, 5].map((n) => (
                <Pressable key={n} onPress={() => setRating(n)} className="mr-1">
                  <Ionicons
                    name={n <= rating ? "star" : "star-outline"}
                    size={28}
                    color="#f59e0b"
                  />
                </Pressable>
              ))}
            </View>
            <View className="mt-3">
              <Field
                label="Anything to add?"
                value={comment}
                onChangeText={setComment}
                multiline
                placeholder="Optional"
              />
              <Button
                title="Submit rating"
                onPress={submitRating}
                loading={busy}
                disabled={rating === 0}
              />
            </View>
          </Card>
        ) : null}

        {request.status === "resolved" ? (
          <View className="mt-1">
            <Button
              title="Close this request"
              variant="secondary"
              onPress={closeRequest}
              loading={busy}
            />
          </View>
        ) : null}

        <RequestConversation
          requestId={request.id}
          locked={request.status === "closed"}
        />
      </ScrollView>
    </Screen>
  );
}
