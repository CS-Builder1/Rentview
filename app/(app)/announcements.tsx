import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";

import {
  Button,
  Card,
  EmptyState,
  Field,
  Loading,
  Screen,
} from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { cachedSelect } from "../../lib/cache";
import { confirmAction } from "../../lib/confirm";
import type { Tables } from "../../lib/database.types";
import { formatDate } from "../../lib/format";
import { notifyPush } from "../../lib/push";
import { supabase } from "../../lib/supabase";

type Announcement = Tables<"announcements"> & {
  properties: { name: string } | null;
};

function notify(title: string, message: string) {
  Platform.OS === "web"
    ? window.alert(`${title}\n\n${message}`)
    : Alert.alert(title, message);
}

export default function Announcements() {
  const router = useRouter();
  const { session } = useAuth();
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [properties, setProperties] = useState<Tables<"properties">[]>([]);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [propertyId, setPropertyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [list, props] = await Promise.all([
      cachedSelect<Announcement[]>(
        "announcements",
        supabase
          .from("announcements")
          .select("*, properties(name)")
          .order("created_at", { ascending: false }),
      ),
      cachedSelect<Tables<"properties">[]>(
        "properties",
        supabase.from("properties").select("*").order("name"),
      ),
    ]);
    setItems(list ?? []);
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
    const { data, error } = await supabase
      .from("announcements")
      .insert({
        owner_id: session.user.id,
        property_id: propertyId,
        title: title.trim(),
        body: body.trim() || null,
      })
      .select("id")
      .single();
    setSaving(false);
    if (error) {
      notify("Could not post", error.message);
      return;
    }
    notifyPush("announcement", data.id);
    setOpen(false);
    setTitle("");
    setBody("");
    setPropertyId(null);
    load();
  }

  function remove(id: string) {
    confirmAction(
      "Delete announcement",
      "Tenants will no longer see this notice.",
      async () => {
        await supabase.from("announcements").delete().eq("id", id);
        load();
      },
    );
  }

  if (!items) return <Loading />;

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/more")
          }
          className="p-2"
        >
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text className="flex-1 text-xl font-bold text-slate-900">
          Announcements
        </Text>
        <Pressable
          onPress={() => setOpen(true)}
          className="flex-row items-center rounded-full bg-brand px-3 py-2"
        >
          <Ionicons name="add" color="#fff" size={18} />
          <Text className="ml-1 font-semibold text-white">Post</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        {items.length === 0 ? (
          <EmptyState
            title="No announcements"
            subtitle="Post water shut-offs, inspections or seasonal reminders to every tenant with portal access."
          />
        ) : (
          items.map((a) => (
            <Card key={a.id}>
              <View className="flex-row items-start justify-between">
                <Text className="flex-1 pr-2 text-base font-semibold text-slate-900">
                  {a.title}
                </Text>
                <Pressable onPress={() => remove(a.id)}>
                  <Ionicons name="trash-outline" size={18} color="#dc2626" />
                </Pressable>
              </View>
              {a.body ? (
                <Text className="mt-1 text-slate-600">{a.body}</Text>
              ) : null}
              <Text className="mt-2 text-xs text-slate-400">
                {a.properties?.name ?? "Whole portfolio"} ·{" "}
                {formatDate(a.created_at)}
              </Text>
            </Card>
          ))
        )}
      </ScrollView>

      <Modal visible={open} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[88%] rounded-t-3xl bg-slate-50"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900">
              New announcement
            </Text>
            <Field
              label="Title"
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Water shut-off Tuesday 9–12"
            />
            <Field
              label="Details"
              value={body}
              onChangeText={setBody}
              multiline
              placeholder="What tenants need to know."
            />

            <Text className="mb-1 text-sm font-medium text-slate-600">
              Who sees it
            </Text>
            <View className="mb-3 flex-row flex-wrap">
              <Pressable
                onPress={() => setPropertyId(null)}
                className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                  propertyId === null
                    ? "border-brand bg-brand"
                    : "border-slate-300 bg-white"
                }`}
              >
                <Text
                  className={
                    propertyId === null
                      ? "font-medium text-white"
                      : "text-slate-700"
                  }
                >
                  Whole portfolio
                </Text>
              </Pressable>
              {properties.map((p) => (
                <Pressable
                  key={p.id}
                  onPress={() => setPropertyId(p.id)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    propertyId === p.id
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  <Text
                    className={
                      propertyId === p.id
                        ? "font-medium text-white"
                        : "text-slate-700"
                    }
                  >
                    {p.name}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <Button
                  title="Cancel"
                  variant="secondary"
                  onPress={() => setOpen(false)}
                />
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
