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
import { confirmAction } from "../../lib/confirm";
import type { Tables } from "../../lib/database.types";
import { supabase } from "../../lib/supabase";

export default function Vendors() {
  const router = useRouter();
  const { session } = useAuth();
  const [vendors, setVendors] = useState<Tables<"vendors">[] | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [trade, setTrade] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase.from("vendors").select("*").order("name");
    setVendors(data ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function reset() {
    setName("");
    setTrade("");
    setPhone("");
    setEmail("");
    setCompany("");
    setNotes("");
    setEditingId(null);
  }

  function openAdd() {
    reset();
    setOpen(true);
  }

  function openEdit(v: Tables<"vendors">) {
    setName(v.name);
    setTrade(v.trade ?? "");
    setPhone(v.phone ?? "");
    setEmail(v.email ?? "");
    setCompany(v.company ?? "");
    setNotes(v.notes ?? "");
    setEditingId(v.id);
    setOpen(true);
  }

  async function save() {
    if (!name.trim() || !session) return;
    setSaving(true);
    const payload = {
      name: name.trim(),
      trade: trade.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      company: company.trim() || null,
      notes: notes.trim() || null,
    };
    const { error } = editingId
      ? await supabase.from("vendors").update(payload).eq("id", editingId)
      : await supabase
          .from("vendors")
          .insert({ ...payload, owner_id: session.user.id });
    setSaving(false);
    if (!error) {
      setOpen(false);
      reset();
      load();
    }
  }

  function remove() {
    if (!editingId) return;
    confirmAction(
      "Delete vendor",
      "This removes the vendor. Work orders keep their history but are unassigned. This cannot be undone.",
      async () => {
        await supabase.from("vendors").delete().eq("id", editingId);
        setOpen(false);
        reset();
        load();
      },
    );
  }

  if (!vendors) return <Loading />;

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
          Vendors
        </Text>
        <Pressable
          onPress={openAdd}
          className="flex-row items-center rounded-full bg-brand px-3 py-2"
        >
          <Ionicons name="add" color="#fff" size={18} />
          <Text className="ml-1 font-semibold text-white">Add</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        {vendors.length === 0 ? (
          <EmptyState
            title="No vendors"
            subtitle="Add the plumbers, electricians and technicians you dispatch to jobs."
          />
        ) : (
          vendors.map((v) => (
            <Card key={v.id} onPress={() => openEdit(v)}>
              <View className="flex-row items-center justify-between">
                <Text className="flex-1 pr-2 text-base font-semibold text-slate-900">
                  {v.name}
                </Text>
                {v.trade ? (
                  <Text className="text-slate-500">{v.trade}</Text>
                ) : null}
              </View>
              {v.phone || v.email ? (
                <Text className="mt-1 text-slate-500">
                  {[v.phone, v.email].filter(Boolean).join("  ·  ")}
                </Text>
              ) : null}
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
              {editingId ? "Edit vendor" : "New vendor"}
            </Text>
            <Field label="Name" value={name} onChangeText={setName} placeholder="e.g. Island Plumbing Co." />
            <Field label="Trade" value={trade} onChangeText={setTrade} placeholder="Plumber, Electrician…" />
            <Field label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
            <Field label="Company" value={company} onChangeText={setCompany} />
            <Field label="Notes" value={notes} onChangeText={setNotes} multiline />

            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <Button
                  title="Cancel"
                  variant="secondary"
                  onPress={() => {
                    setOpen(false);
                    reset();
                  }}
                />
              </View>
              <View className="flex-1">
                <Button title="Save" onPress={save} loading={saving} />
              </View>
            </View>
            {editingId ? (
              <View className="mt-3">
                <Button title="Delete vendor" variant="danger" onPress={remove} />
              </View>
            ) : null}
          </ScrollView>
        </View>
      </Modal>
    </Screen>
  );
}
