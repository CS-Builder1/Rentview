import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";

import {
  RequestPhotos,
  RequestThread,
  StatusTimeline,
} from "../../../components/RequestShared";
import { useToast } from "../../../components/Toast";
import { Badge, Button, Card, Field, Icon, Loading, Screen } from "../../../components/ui";
import { useAuth } from "../../../lib/auth";
import { cachedSelect } from "../../../lib/cache";
import type { Tables } from "../../../lib/database.types";
import { formatDate, titleCase } from "../../../lib/format";
import { supabase } from "../../../lib/supabase";
import { useTheme } from "../../../lib/theme";

type Request = Tables<"maintenance_requests">;
type LeaseDetails = Tables<"tenant_lease_details">;

export default function TenantRequestDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const { colors } = useTheme();
  const toast = useToast();
  const [request, setRequest] = useState<Request | null>(null);
  const [landlordName, setLandlordName] = useState("Landlord");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [rating, setRating] = useState(0);
  const [ratingComment, setRatingComment] = useState("");
  const [savingRating, setSavingRating] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const rows = await cachedSelect<Request[]>(
      `tenant.request.${id}`,
      supabase.from("maintenance_requests").select("*").eq("id", id),
    );
    setRequest(rows?.[0] ?? null);
    const leases = await cachedSelect<LeaseDetails[]>(
      "tenant.lease",
      supabase.from("tenant_lease_details").select("*"),
    );
    const name = leases?.[0]?.landlord_name;
    if (name) setLandlordName(name);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshKey((k) => k + 1);
    setRefreshing(false);
  }, [load]);

  async function submitRating() {
    if (!request || rating === 0) return;
    setSavingRating(true);
    try {
      const { error } = await supabase
        .from("maintenance_requests")
        .update({ rating, rating_comment: ratingComment.trim() || null })
        .eq("id", request.id);
      if (error) throw error;
      toast.show("Thanks for the feedback!");
      load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Could not save rating", "error");
    } finally {
      setSavingRating(false);
    }
  }

  if (!request) return <Loading />;

  const showRating = request.status === "resolved" || request.status === "closed";

  return (
    <Screen>
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable onPress={() => router.back()} className="p-1 pr-3">
          <Icon name="chevron-back" size={24} />
        </Pressable>
        <Text
          className="flex-1 text-xl font-bold text-slate-900 dark:text-slate-100"
          numberOfLines={1}
        >
          {request.title}
        </Text>
        <Badge label={request.status} />
      </View>

      <ScrollView
        contentContainerClassName="px-5 pb-10"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <Card>
          <View className="flex-row items-center justify-between">
            <Badge label={request.urgency} />
            <Text className="text-xs text-slate-400 dark:text-slate-500">
              {titleCase(request.category)} · {formatDate(request.created_at)}
            </Text>
          </View>
          {request.description ? (
            <Text className="mt-2 text-slate-600 dark:text-slate-300">
              {request.description}
            </Text>
          ) : null}
        </Card>

        <RequestPhotos requestId={request.id} />

        <StatusTimeline status={request.status} />

        {showRating ? (
          <Card>
            <Text className="mb-1 text-sm font-semibold uppercase text-slate-400 dark:text-slate-500">
              {request.rating ? "Your rating" : "How was the repair?"}
            </Text>
            <View className="mb-2 flex-row">
              {[1, 2, 3, 4, 5].map((star) => {
                const active = (request.rating ?? rating) >= star;
                return (
                  <Pressable
                    key={star}
                    disabled={!!request.rating}
                    onPress={() => setRating(star)}
                    className="mr-1 p-1"
                  >
                    <Ionicons
                      name={active ? "star" : "star-outline"}
                      size={26}
                      color={active ? "#f59e0b" : colors.inkFaint}
                    />
                  </Pressable>
                );
              })}
            </View>
            {request.rating ? (
              request.rating_comment ? (
                <Text className="text-slate-600 dark:text-slate-300">
                  “{request.rating_comment}”
                </Text>
              ) : null
            ) : (
              <>
                <Field
                  label="Comment (optional)"
                  value={ratingComment}
                  onChangeText={setRatingComment}
                  placeholder="Anything the landlord should know?"
                />
                <Button
                  title="Submit rating"
                  onPress={submitRating}
                  loading={savingRating}
                  disabled={rating === 0}
                />
              </>
            )}
          </Card>
        ) : null}

        {session ? (
          <RequestThread
            requestId={request.id}
            currentUserId={session.user.id}
            senderName={(session.user.user_metadata?.full_name as string) ?? "You"}
            counterpartName={landlordName}
            refreshKey={refreshKey}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}
