import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Image, Modal, Pressable, ScrollView, Text, View } from "react-native";

import { SkeletonList } from "../../../components/Skeleton";
import { useToast } from "../../../components/Toast";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Screen,
} from "../../../components/ui";
import { pickImageForUpload, type PickedImage } from "../../../lib/attachments";
import { useAuth } from "../../../lib/auth";
import { cachedSelect } from "../../../lib/cache";
import type { Tables } from "../../../lib/database.types";
import { Constants } from "../../../lib/database.types";
import { formatDate, titleCase } from "../../../lib/format";
import { useOffline } from "../../../lib/offline";
import { supabase } from "../../../lib/supabase";
import { newUuid } from "../../../lib/uuid";

type Request = Tables<"maintenance_requests">;
type LeaseDetails = Tables<"tenant_lease_details">;

const CATEGORIES = Constants.public.Enums.request_category;
const URGENCIES = Constants.public.Enums.wo_priority;

const categoryIcons: Record<(typeof CATEGORIES)[number], keyof typeof Ionicons.glyphMap> = {
  plumbing: "water",
  electrical: "flash",
  appliance: "cube",
  hvac: "thermometer",
  pest: "bug",
  general: "hammer",
  other: "help-circle",
};

export default function TenantRequests() {
  const router = useRouter();
  const { session } = useAuth();
  const { submitInsert, submitPhoto } = useOffline();
  const toast = useToast();
  const [requests, setRequests] = useState<Request[] | null>(null);
  const [lease, setLease] = useState<LeaseDetails | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  // form
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("general");
  const [urgency, setUrgency] = useState<(typeof URGENCIES)[number]>("medium");
  const [photos, setPhotos] = useState<PickedImage[]>([]);

  const load = useCallback(async () => {
    const [reqs, leases] = await Promise.all([
      cachedSelect<Request[]>(
        "tenant.requests",
        supabase
          .from("maintenance_requests")
          .select("*")
          .order("created_at", { ascending: false }),
      ),
      cachedSelect<LeaseDetails[]>(
        "tenant.lease",
        supabase.from("tenant_lease_details").select("*"),
      ),
    ]);
    setRequests(reqs ?? []);
    setLease(leases?.find((l) => l.status === "active") ?? leases?.[0] ?? null);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function resetForm() {
    setTitle("");
    setDescription("");
    setCategory("general");
    setUrgency("medium");
    setPhotos([]);
  }

  async function addPhoto() {
    try {
      const img = await pickImageForUpload();
      if (img) setPhotos((prev) => [...prev, img].slice(0, 3));
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Could not read image", "error");
    }
  }

  async function save() {
    if (!title.trim() || !session) return;
    if (!lease?.lease_id || !lease.unit_id || !lease.property_id || !lease.owner_id) {
      toast.show("No active lease is linked to your account", "error");
      return;
    }
    setSaving(true);
    try {
      // Client-generated id so photo rows/paths can reference the request
      // even while the insert itself is queued offline.
      const requestId = newUuid();
      const result = await submitInsert("maintenance_requests", {
        id: requestId,
        owner_id: lease.owner_id,
        lease_id: lease.lease_id,
        unit_id: lease.unit_id,
        property_id: lease.property_id,
        tenant_user_id: session.user.id,
        title: title.trim(),
        description: description.trim() || null,
        category,
        urgency,
      });
      for (const [i, photo] of photos.entries()) {
        await submitPhoto({
          base64: photo.base64,
          contentType: photo.contentType,
          storagePath: `requests/${requestId}/${Date.now()}-${i}.${photo.ext}`,
          doc: { request_id: requestId },
          docTable: "request_photos",
        });
      }
      setAdding(false);
      resetForm();
      if (result === "queued") {
        toast.show("Saved offline — will send when you're back online", "info");
      } else {
        toast.show("Request sent to your landlord");
        load();
      }
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Could not send request", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen>
      <View className="flex-row items-center justify-between px-5 pb-2 pt-2">
        <Text className="text-2xl font-bold text-slate-900 dark:text-slate-100">Requests</Text>
        <Pressable
          onPress={() => setAdding(true)}
          className="flex-row items-center rounded-full bg-brand px-3 py-2"
        >
          <Ionicons name="add" color="#fff" size={18} />
          <Text className="ml-1 font-semibold text-white">New</Text>
        </Pressable>
      </View>

      {!requests ? (
        <SkeletonList />
      ) : (
        <ScrollView contentContainerClassName="px-5 pb-10">
          {requests.length === 0 ? (
            <EmptyState
              icon="construct-outline"
              title="Nothing reported"
              subtitle="Broken AC? Leaky tap? Report it here and track the fix."
            />
          ) : (
            requests.map((r) => (
              <Card key={r.id} onPress={() => router.push(`/(tenant)/request/${r.id}`)}>
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 flex-row items-center pr-2">
                    <Icon name={categoryIcons[r.category] ?? "hammer"} size={16} />
                    <Text className="ml-2 flex-1 text-base font-semibold text-slate-900 dark:text-slate-100">
                      {r.title}
                    </Text>
                  </View>
                  <Badge label={r.status} />
                </View>
                <View className="mt-2 flex-row items-center justify-between">
                  <Badge label={r.urgency} />
                  <Text className="text-xs text-slate-400 dark:text-slate-500">
                    {formatDate(r.created_at)}
                  </Text>
                </View>
              </Card>
            ))
          )}
        </ScrollView>
      )}

      <Modal visible={adding} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[88%] rounded-t-3xl bg-slate-50 dark:bg-slate-900"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900 dark:text-slate-100">
              Report a problem
            </Text>

            <Field
              label="What's wrong?"
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. AC not cooling"
            />
            <Field
              label="Details (optional)"
              value={description}
              onChangeText={setDescription}
              placeholder="When it started, what you've tried…"
              multiline
            />

            <Text className="mb-1 text-sm font-medium text-slate-600 dark:text-slate-300">
              Category
            </Text>
            <View className="mb-3 flex-row flex-wrap">
              {CATEGORIES.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => setCategory(c)}
                  className={`mb-2 mr-2 flex-row items-center rounded-full border px-3 py-2 ${
                    category === c
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white dark:border-slate-700 dark:bg-surface-dark"
                  }`}
                >
                  <Ionicons
                    name={categoryIcons[c]}
                    size={14}
                    color={category === c ? "#fff" : "#94a3b8"}
                  />
                  <Text
                    className={`ml-1.5 ${
                      category === c ? "font-medium text-white" : "text-slate-700 dark:text-slate-200"
                    }`}
                  >
                    {titleCase(c)}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text className="mb-1 text-sm font-medium text-slate-600 dark:text-slate-300">
              How urgent?
            </Text>
            <View className="mb-3 flex-row flex-wrap">
              {URGENCIES.map((u) => (
                <Pressable
                  key={u}
                  onPress={() => setUrgency(u)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    urgency === u
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white dark:border-slate-700 dark:bg-surface-dark"
                  }`}
                >
                  <Text
                    className={
                      urgency === u ? "font-medium text-white" : "text-slate-700 dark:text-slate-200"
                    }
                  >
                    {titleCase(u)}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text className="mb-1 text-sm font-medium text-slate-600 dark:text-slate-300">
              Photos (optional, up to 3)
            </Text>
            <View className="mb-3 flex-row flex-wrap items-center">
              {photos.map((p, i) => (
                <View key={i} className="mb-2 mr-2">
                  <Image
                    source={{ uri: `data:${p.contentType};base64,${p.base64}` }}
                    style={{ width: 64, height: 64, borderRadius: 12 }}
                  />
                  <Pressable
                    onPress={() => setPhotos((prev) => prev.filter((_, idx) => idx !== i))}
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-slate-700 p-0.5"
                  >
                    <Ionicons name="close" size={12} color="#fff" />
                  </Pressable>
                </View>
              ))}
              {photos.length < 3 ? (
                <Pressable
                  onPress={addPhoto}
                  className="mb-2 h-16 w-16 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white dark:border-slate-700 dark:bg-surface-dark"
                >
                  <Icon name="camera" size={20} tone="faint" />
                </Pressable>
              ) : null}
            </View>

            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <Button
                  title="Cancel"
                  variant="secondary"
                  onPress={() => {
                    setAdding(false);
                    resetForm();
                  }}
                />
              </View>
              <View className="flex-1">
                <Button title="Send" onPress={save} loading={saving} />
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
