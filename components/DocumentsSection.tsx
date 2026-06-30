import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import { Alert, Modal, Platform, Pressable, Text, View } from "react-native";

import {
  openAttachment,
  pickAndUploadDocument,
} from "../lib/attachments";
import { useAuth } from "../lib/auth";
import type { Tables } from "../lib/database.types";
import { Constants } from "../lib/database.types";
import { formatDate, titleCase } from "../lib/format";
import { supabase } from "../lib/supabase";
import { Badge, Button, Card, Field } from "./ui";

export type DocScope =
  | { kind: "asset"; assetId: string; propertyId: string; unitId: string | null }
  | { kind: "property"; propertyId: string }
  | { kind: "unit"; unitId: string; propertyId: string }
  | {
      kind: "workOrder";
      workOrderId: string;
      propertyId: string;
      unitId: string | null;
    };

const DOC_TYPES = Constants.public.Enums.doc_type.filter((t) => t !== "photo");

function notify(title: string, message: string) {
  Platform.OS === "web"
    ? window.alert(`${title}\n\n${message}`)
    : Alert.alert(title, message);
}

export function DocumentsSection({
  scope,
  defaultDocType = "other",
}: {
  scope: DocScope;
  defaultDocType?: (typeof DOC_TYPES)[number];
}) {
  const { session } = useAuth();
  const [docs, setDocs] = useState<Tables<"documents">[]>([]);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [docType, setDocType] =
    useState<(typeof DOC_TYPES)[number]>(defaultDocType);
  const [picked, setPicked] = useState<{
    storagePath: string;
    mimeType: string;
    sizeBytes: number;
    name: string;
  } | null>(null);

  const load = useCallback(async () => {
    let query = supabase.from("documents").select("*");
    if (scope.kind === "asset") {
      query = query.eq("asset_id", scope.assetId);
    } else if (scope.kind === "workOrder") {
      // Exclude photos — the work-order screen shows those in a separate grid.
      query = query.eq("work_order_id", scope.workOrderId).neq("doc_type", "photo");
    } else if (scope.kind === "unit") {
      // Unit-level only — not docs that belong to an asset or work order.
      query = query
        .eq("unit_id", scope.unitId)
        .is("asset_id", null)
        .is("work_order_id", null);
    } else {
      // Property-level only — exclude docs that belong to a unit or asset.
      query = query
        .eq("property_id", scope.propertyId)
        .is("asset_id", null)
        .is("unit_id", null);
    }
    const { data } = await query.order("created_at", { ascending: false });
    setDocs(data ?? []);
  }, [scope]);

  useEffect(() => {
    load();
  }, [load]);

  async function pickFile() {
    if (!session) return;
    try {
      const uploaded = await pickAndUploadDocument(session.user.id, "documents");
      if (uploaded) {
        setPicked(uploaded);
        if (!name) setName(uploaded.name);
      }
    } catch (e) {
      notify("Upload failed", e instanceof Error ? e.message : String(e));
    }
  }

  async function save() {
    if (!picked || !session) {
      notify("Choose a file", "Pick a file to upload first.");
      return;
    }
    const base = {
      owner_id: session.user.id,
      name: name.trim() || picked.name,
      doc_type: docType,
      storage_path: picked.storagePath,
      mime_type: picked.mimeType,
      size_bytes: picked.sizeBytes,
    };
    const payload =
      scope.kind === "asset"
        ? {
            ...base,
            asset_id: scope.assetId,
            property_id: scope.propertyId,
            unit_id: scope.unitId,
          }
        : scope.kind === "workOrder"
          ? {
              ...base,
              work_order_id: scope.workOrderId,
              property_id: scope.propertyId,
              unit_id: scope.unitId,
            }
          : scope.kind === "unit"
            ? {
                ...base,
                unit_id: scope.unitId,
                property_id: scope.propertyId,
              }
            : { ...base, property_id: scope.propertyId };

    setSaving(true);
    const { error } = await supabase.from("documents").insert(payload);
    setSaving(false);
    if (error) {
      notify("Could not save", error.message);
      return;
    }
    setAdding(false);
    setPicked(null);
    setName("");
    setDocType(defaultDocType);
    load();
  }

  async function remove(doc: Tables<"documents">) {
    const run = async () => {
      await supabase.storage.from("attachments").remove([doc.storage_path]);
      await supabase.from("documents").delete().eq("id", doc.id);
      load();
    };
    if (Platform.OS === "web") {
      if (window.confirm(`Delete "${doc.name}"?`)) run();
    } else {
      Alert.alert("Delete document", `Delete "${doc.name}"?`, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: run },
      ]);
    }
  }

  return (
    <View>
      <View className="mb-2 mt-4 flex-row items-center justify-between">
        <Text className="text-lg font-semibold text-slate-900">
          Documents ({docs.length})
        </Text>
        <Pressable
          onPress={() => setAdding(true)}
          className="flex-row items-center rounded-full bg-brand px-3 py-1.5"
        >
          <Ionicons name="add" color="#fff" size={16} />
          <Text className="ml-1 font-semibold text-white">Add</Text>
        </Pressable>
      </View>

      {docs.length === 0 ? (
        <Text className="mb-2 text-slate-400">No documents attached.</Text>
      ) : (
        docs.map((d) => (
          <Card key={d.id} onPress={() => openAttachment(d.storage_path)}>
            <View className="flex-row items-center">
              <Ionicons name="document-text-outline" size={20} color="#0f766e" />
              <View className="ml-3 flex-1">
                <Text className="font-medium text-slate-900" numberOfLines={1}>
                  {d.name}
                </Text>
                <Text className="text-xs text-slate-400">
                  {formatDate(d.created_at)}
                </Text>
              </View>
              <Badge label={d.doc_type} />
              <Pressable onPress={() => remove(d)} className="ml-2">
                <Ionicons name="trash-outline" size={18} color="#dc2626" />
              </Pressable>
            </View>
          </Card>
        ))
      )}

      <Modal visible={adding} animationType="slide" transparent>
        <View className="flex-1 justify-end bg-black/40">
          <View className="rounded-t-3xl bg-slate-50 p-5">
            <Text className="mb-4 text-xl font-bold text-slate-900">
              Add document
            </Text>

            <Pressable
              onPress={pickFile}
              className="mb-3 flex-row items-center justify-center rounded-xl border border-dashed border-brand bg-white px-4 py-4"
            >
              <Ionicons
                name={picked ? "checkmark-circle" : "cloud-upload-outline"}
                size={20}
                color="#0f766e"
              />
              <Text className="ml-2 font-medium text-brand" numberOfLines={1}>
                {picked ? picked.name : "Choose a file"}
              </Text>
            </Pressable>

            <Field
              label="Name"
              value={name}
              onChangeText={setName}
              placeholder="e.g. AC warranty"
            />

            <Text className="mb-1 text-sm font-medium text-slate-600">Type</Text>
            <View className="mb-3 flex-row flex-wrap">
              {DOC_TYPES.map((t) => (
                <Pressable
                  key={t}
                  onPress={() => setDocType(t)}
                  className={`mb-2 mr-2 rounded-full border px-3 py-2 ${
                    docType === t
                      ? "border-brand bg-brand"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  <Text
                    className={
                      docType === t ? "font-medium text-white" : "text-slate-700"
                    }
                  >
                    {titleCase(t)}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View className="mt-2 flex-row gap-3">
              <View className="flex-1">
                <Button
                  title="Cancel"
                  variant="secondary"
                  onPress={() => {
                    setAdding(false);
                    setPicked(null);
                  }}
                />
              </View>
              <View className="flex-1">
                <Button title="Save" onPress={save} loading={saving} />
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
