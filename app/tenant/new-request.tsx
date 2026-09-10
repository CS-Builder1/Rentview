import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";

import { Button, Card, Field, Loading, Screen } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { cachedSelect } from "../../lib/cache";
import type { Tables } from "../../lib/database.types";
import { Constants } from "../../lib/database.types";
import { titleCase } from "../../lib/format";
import { notifyPush } from "../../lib/push";
import { supabase } from "../../lib/supabase";

type LeaseView = Tables<"tenant_lease_details">;

const CATEGORIES = Constants.public.Enums.request_category;
const URGENCIES = Constants.public.Enums.wo_priority;

function notify(title: string, message: string) {
  Platform.OS === "web"
    ? window.alert(`${title}\n\n${message}`)
    : Alert.alert(title, message);
}

export default function NewRequest() {
  const router = useRouter();
  const { session } = useAuth();

  const [leases, setLeases] = useState<LeaseView[] | null>(null);
  const [leaseId, setLeaseId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] =
    useState<(typeof CATEGORIES)[number]>("general");
  const [urgency, setUrgency] = useState<(typeof URGENCIES)[number]>("medium");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    // Only an ACTIVE lease can carry a request — the database enforces this
    // too, so the picker never offers one that would be rejected.
    const data = await cachedSelect<LeaseView[]>(
      "tenant:activeLeases",
      supabase.from("tenant_lease_details").select("*").eq("status", "active"),
    );
    setLeases(data ?? []);
    if ((data ?? []).length === 1) setLeaseId(data![0].lease_id);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function submit() {
    const lease = leases?.find((l) => l.lease_id === leaseId);
    if (!session || !lease) {
      notify("Pick your unit", "Choose which unit this request is about.");
      return;
    }
    if (!title.trim()) {
      notify("Add a title", "Give the request a short title.");
      return;
    }
    if (!lease.lease_id || !lease.unit_id || !lease.property_id || !lease.owner_id) {
      notify("Lease unavailable", "Reload the app and try again.");
      return;
    }

    setSaving(true);
    const { data, error } = await supabase
      .from("maintenance_requests")
      .insert({
        owner_id: lease.owner_id,
        lease_id: lease.lease_id,
        unit_id: lease.unit_id,
        property_id: lease.property_id,
        tenant_user_id: session.user.id,
        title: title.trim(),
        description: description.trim() || null,
        category,
        urgency,
      })
      .select("id")
      .single();
    setSaving(false);

    if (error) {
      notify("Could not submit", error.message);
      return;
    }
    notifyPush("request_created", data.id);
    router.replace(`/tenant/request/${data.id}`);
  }

  if (!leases) return <Loading />;

  return (
    <Screen>
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/tenant")
          }
          className="p-2"
        >
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text className="flex-1 text-xl font-bold text-slate-900">
          Report a repair
        </Text>
      </View>

      <ScrollView
        contentContainerClassName="px-5 pb-10"
        keyboardShouldPersistTaps="handled"
      >
        {leases.length === 0 ? (
          <Card>
            <Text className="text-slate-600">
              You have no active lease linked to this account, so there is
              nothing to report against yet.
            </Text>
          </Card>
        ) : (
          <>
            {leases.length > 1 ? (
              <>
                <Text className="mb-1 text-sm font-medium text-slate-600">
                  Which unit
                </Text>
                <View className="mb-3 flex-row flex-wrap">
                  {leases.map((l) => (
                    <Pressable
                      key={l.lease_id}
                      onPress={() => setLeaseId(l.lease_id)}
                      className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                        leaseId === l.lease_id
                          ? "border-brand bg-brand"
                          : "border-slate-300 bg-white"
                      }`}
                    >
                      <Text
                        className={
                          leaseId === l.lease_id
                            ? "font-medium text-white"
                            : "text-slate-700"
                        }
                      >
                        {[l.property_name, l.unit_label]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}

            <Field
              label="What's wrong"
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Kitchen tap is leaking"
            />
            <Field
              label="Details"
              value={description}
              onChangeText={setDescription}
              multiline
              placeholder="When it started, what you've noticed, anything the technician should know."
            />

            <Text className="mb-1 text-sm font-medium text-slate-600">
              Category
            </Text>
            <View className="mb-3 flex-row flex-wrap">
              {CATEGORIES.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => setCategory(c)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    category === c
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  <Text
                    className={
                      category === c ? "font-medium text-white" : "text-slate-700"
                    }
                  >
                    {titleCase(c)}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text className="mb-1 text-sm font-medium text-slate-600">
              How urgent
            </Text>
            <View className="mb-4 flex-row flex-wrap">
              {URGENCIES.map((u) => (
                <Pressable
                  key={u}
                  onPress={() => setUrgency(u)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    urgency === u
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  <Text
                    className={
                      urgency === u ? "font-medium text-white" : "text-slate-700"
                    }
                  >
                    {titleCase(u)}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Button title="Submit request" onPress={submit} loading={saving} />
            <Text className="mt-2 text-xs text-slate-400">
              You can add photos and message your landlord on the next screen.
            </Text>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
