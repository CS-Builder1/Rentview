import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";

import { SkeletonList } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import {
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  Screen,
} from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { cachedSelect } from "../../lib/cache";
import { confirmAction } from "../../lib/confirm";
import type { Tables } from "../../lib/database.types";
import { formatDate } from "../../lib/format";
import { supabase } from "../../lib/supabase";

type Announcement = Tables<"announcements"> & {
  properties: { name: string } | null;
};

export default function Announcements() {
  const router = useRouter();
  const { session } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [properties, setProperties] = useState<Tables<"properties">[]>([]);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  // form
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [propertyId, setPropertyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [anns, props] = await Promise.all([
      cachedSelect<Announcement[]>(
        "owner.announcements",
        supabase
          .from("announcements")
          .select("*, properties(name)")
          .order("created_at", { ascending: false }),
      ),
      cachedSelect<Tables<"properties">[]>(
        "properties_min",
        supabase.from("properties").select("*").order("name"),
      ),
    ]);
    setItems(anns ?? []);
    setProperties(props ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function save() {
    if (!title.trim() || !session) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("announcements").insert({
        owner_id: session.user.id,
        property_id: propertyId,
        title: title.trim(),
        body: body.trim() || null,
      });
      if (error) throw error;
      setAdding(false);
      setTitle("");
      setBody("");
      setPropertyId(null);
      toast.show("Announcement posted — tenants will see it on their home screen");
      load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Could not post", "error");
    } finally {
      setSaving(false);
    }
  }

  function remove(a: Announcement) {
    confirmAction(
      "Delete announcement",
      "Tenants will no longer see this announcement.",
      async () => {
        await supabase.from("announcements").delete().eq("id", a.id);
        load();
      },
    );
  }

  return (
    <Screen>
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable onPress={() => router.back()} className="p-1 pr-3">
          <Icon name="chevron-back" size={24} />
        </Pressable>
        <Text className="flex-1 text-xl font-bold text-slate-900 dark:text-slate-100">
          Announcements
        </Text>
        <Pressable
          onPress={() => setAdding(true)}
          className="flex-row items-center rounded-full bg-brand px-3 py-2"
        >
          <Ionicons name="add" color="#fff" size={18} />
          <Text className="ml-1 font-semibold text-white">New</Text>
        </Pressable>
      </View>

      {!items ? (
        <SkeletonList />
      ) : (
        <ScrollView contentContainerClassName="px-5 pb-10">
          {items.length === 0 ? (
            <EmptyState
              icon="megaphone-outline"
              title="No announcements"
              subtitle="Post water shut-offs, inspections or reminders — tenants see them instantly on their home screen."
            />
          ) : (
            items.map((a) => (
              <Card key={a.id}>
                <View className="flex-row items-center justify-between">
                  <Text className="flex-1 pr-2 text-base font-semibold text-slate-900 dark:text-slate-100">
                    {a.title}
                  </Text>
                  <Pressable onPress={() => remove(a)} className="p-1">
                    <Icon name="trash-outline" size={16} tone="danger" />
                  </Pressable>
                </View>
                {a.body ? (
                  <Text className="mt-1 text-slate-600 dark:text-slate-300">{a.body}</Text>
                ) : null}
                <Text className="mt-2 text-xs text-slate-400 dark:text-slate-500">
                  {a.properties?.name ?? "All properties"} · {formatDate(a.created_at)}
                </Text>
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
              New announcement
            </Text>
            <Field
              label="Title"
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Water shut-off Thursday 9–11am"
            />
            <Field
              label="Details (optional)"
              value={body}
              onChangeText={setBody}
              placeholder="What tenants should know…"
              multiline
            />
            <Text className="mb-1 text-sm font-medium text-slate-600 dark:text-slate-300">
              Audience
            </Text>
            <View className="mb-3 flex-row flex-wrap">
              <Pressable
                onPress={() => setPropertyId(null)}
                className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                  propertyId === null
                    ? "border-brand bg-brand"
                    : "border-slate-300 bg-white dark:border-slate-700 dark:bg-surface-dark"
                }`}
              >
                <Text
                  className={
                    propertyId === null
                      ? "font-medium text-white"
                      : "text-slate-700 dark:text-slate-200"
                  }
                >
                  All properties
                </Text>
              </Pressable>
              {properties.map((p) => (
                <Pressable
                  key={p.id}
                  onPress={() => setPropertyId(p.id)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    propertyId === p.id
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white dark:border-slate-700 dark:bg-surface-dark"
                  }`}
                >
                  <Text
                    className={
                      propertyId === p.id
                        ? "font-medium text-white"
                        : "text-slate-700 dark:text-slate-200"
                    }
                  >
                    {p.name}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <Button title="Cancel" variant="secondary" onPress={() => setAdding(false)} />
              </View>
              <View className="flex-1">
                <Button title="Post" onPress={save} loading={saving} />
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
