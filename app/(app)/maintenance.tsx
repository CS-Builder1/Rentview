import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";

import {
  Button,
  Card,
  EmptyState,
  Field,
  Loading,
  Screen,
} from "../../components/ui";
import { useAuth } from "../../lib/auth";
import type { Tables } from "../../lib/database.types";
import { Constants } from "../../lib/database.types";
import { formatDate, titleCase } from "../../lib/format";
import { supabase } from "../../lib/supabase";

type Schedule = Tables<"maintenance_schedules"> & {
  properties: { name: string } | null;
};

const FREQS = Constants.public.Enums.schedule_freq;

const FREQ_DAYS: Record<string, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  quarterly: 91,
  biannual: 182,
  annual: 365,
};

function addDays(from: Date, days: number): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function isDue(s: Schedule): boolean {
  return !!s.next_due && new Date(s.next_due) <= new Date();
}

export default function Maintenance() {
  const router = useRouter();
  const { session } = useAuth();
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [properties, setProperties] = useState<Tables<"properties">[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  // form
  const [title, setTitle] = useState("");
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [frequency, setFrequency] = useState<(typeof FREQS)[number]>("quarterly");
  const [intervalDays, setIntervalDays] = useState("");
  const [nextDue, setNextDue] = useState("");

  const load = useCallback(async () => {
    const [s, p] = await Promise.all([
      supabase
        .from("maintenance_schedules")
        .select("*, properties(name)")
        .order("next_due", { ascending: true, nullsFirst: false }),
      supabase.from("properties").select("*").order("name"),
    ]);
    setSchedules((s.data as Schedule[]) ?? []);
    setProperties(p.data ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function resetForm() {
    setTitle("");
    setPropertyId(null);
    setFrequency("quarterly");
    setIntervalDays("");
    setNextDue("");
  }

  async function save() {
    if (!title.trim() || !session) return;
    setBusy(true);
    await supabase.from("maintenance_schedules").insert({
      owner_id: session.user.id,
      property_id: propertyId,
      title: title.trim(),
      frequency,
      interval_days: frequency === "custom" && intervalDays ? Number(intervalDays) : null,
      next_due: nextDue.trim() || null,
    });
    setBusy(false);
    setAdding(false);
    resetForm();
    load();
  }

  async function markDone(s: Schedule) {
    const today = new Date();
    const step =
      s.frequency === "custom"
        ? s.interval_days ?? 30
        : FREQ_DAYS[s.frequency] ?? 30;
    setBusy(true);
    await supabase
      .from("maintenance_schedules")
      .update({
        last_done: today.toISOString().slice(0, 10),
        next_due: addDays(today, step),
      })
      .eq("id", s.id);
    setBusy(false);
    load();
  }

  if (!schedules) return <Loading />;

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable onPress={() => router.back()} className="p-2">
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text className="flex-1 text-xl font-bold text-slate-900">
          Preventive maintenance
        </Text>
        <Pressable
          onPress={() => setAdding(true)}
          className="flex-row items-center rounded-full bg-brand px-3 py-2"
        >
          <Ionicons name="add" color="#fff" size={18} />
          <Text className="ml-1 font-semibold text-white">Add</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        {schedules.length === 0 ? (
          <EmptyState
            title="No schedules"
            subtitle="Set recurring tasks like quarterly AC service or annual roof checks, then mark them done to roll the next due date forward."
          />
        ) : (
          schedules.map((s) => (
            <Card key={s.id}>
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 pr-2 text-base font-semibold text-slate-900">
                  {s.title}
                </Text>
                {isDue(s) ? (
                  <View className="rounded-full bg-amber-100 px-2.5 py-0.5">
                    <Text className="text-xs font-medium text-amber-800">Due</Text>
                  </View>
                ) : null}
              </View>
              <Text className="mt-1 text-slate-500">
                {titleCase(s.frequency)}
                {s.properties?.name ? ` · ${s.properties.name}` : ""}
              </Text>
              <View className="mt-2 flex-row items-center justify-between">
                <Text className="text-xs text-slate-400">
                  {s.next_due ? `Next: ${formatDate(s.next_due)}` : "No date set"}
                  {s.last_done ? ` · Last: ${formatDate(s.last_done)}` : ""}
                </Text>
                <Pressable
                  disabled={busy}
                  onPress={() => markDone(s)}
                  className="rounded-full bg-slate-200 px-3 py-1.5"
                >
                  <Text className="text-sm font-medium text-slate-700">
                    Mark done
                  </Text>
                </Pressable>
              </View>
            </Card>
          ))
        )}
      </ScrollView>

      <Modal visible={adding} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <ScrollView
            className="max-h-[88%] rounded-t-3xl bg-slate-50"
            contentContainerClassName="p-5"
          >
            <Text className="mb-4 text-xl font-bold text-slate-900">
              New schedule
            </Text>

            <Field
              label="Title"
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Quarterly AC service"
            />

            <Text className="mb-1 text-sm font-medium text-slate-600">
              Frequency
            </Text>
            <View className="mb-3 flex-row flex-wrap">
              {FREQS.map((f) => (
                <Pressable
                  key={f}
                  onPress={() => setFrequency(f)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    frequency === f
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  <Text
                    className={
                      frequency === f ? "font-medium text-white" : "text-slate-700"
                    }
                  >
                    {titleCase(f)}
                  </Text>
                </Pressable>
              ))}
            </View>

            {frequency === "custom" ? (
              <Field
                label="Interval (days)"
                value={intervalDays}
                onChangeText={setIntervalDays}
                placeholder="e.g. 45"
                keyboardType="number-pad"
              />
            ) : null}

            <Text className="mb-1 text-sm font-medium text-slate-600">
              Property (optional)
            </Text>
            <View className="mb-3 flex-row flex-wrap">
              {properties.map((p) => (
                <Pressable
                  key={p.id}
                  onPress={() => setPropertyId(propertyId === p.id ? null : p.id)}
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

            <Field
              label="First due date (YYYY-MM-DD, optional)"
              value={nextDue}
              onChangeText={setNextDue}
              placeholder="2026-09-01"
              autoCapitalize="none"
            />

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
                <Button title="Save" onPress={save} loading={busy} />
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
