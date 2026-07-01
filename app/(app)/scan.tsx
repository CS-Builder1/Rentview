import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Stack, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Field, Loading, Screen } from "../../components/ui";
import { supabase } from "../../lib/supabase";

function notify(title: string, message: string) {
  Platform.OS === "web"
    ? window.alert(`${title}\n\n${message}`)
    : Alert.alert(title, message);
}

/** Pull an asset id out of a scanned URL (…/asset/<id>) or accept a raw value. */
function parseCode(raw: string): string {
  const trimmed = raw.trim();
  const marker = "/asset/";
  if (trimmed.includes(marker)) {
    return trimmed.split(marker)[1].split(/[/?#]/)[0];
  }
  return trimmed;
}

export default function Scan() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState("");
  const [resolving, setResolving] = useState(false);
  const handledRef = useRef(false);

  async function resolve(raw: string) {
    if (!raw.trim() || resolving) return;
    setResolving(true);
    const code = parseCode(raw);
    try {
      // Match by asset id first, then by a custom qr_code value.
      let id: string | null = null;
      try {
        const byId = await supabase
          .from("assets")
          .select("id")
          .eq("id", code)
          .maybeSingle();
        id = byId.data?.id ?? null;
      } catch {
        // Not a valid uuid — fall through to qr_code lookup.
      }
      if (!id) {
        const byCode = await supabase
          .from("assets")
          .select("id")
          .eq("qr_code", raw.trim())
          .maybeSingle();
        id = byCode.data?.id ?? null;
      }
      if (id) {
        router.replace(`/asset/${id}`);
      } else {
        notify("No match", "No asset matches that code.");
        handledRef.current = false;
      }
    } catch (e) {
      notify("Could not look up", e instanceof Error ? e.message : String(e));
      handledRef.current = false;
    } finally {
      setResolving(false);
    }
  }

  function onBarcode(data: string) {
    if (handledRef.current) return;
    handledRef.current = true;
    resolve(data);
  }

  const canUseCamera = permission?.granted === true;

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center px-4 pb-2 pt-2">
        <Pressable
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/assets")
          }
          className="p-2"
        >
          <Ionicons name="chevron-back" size={24} color="#0f766e" />
        </Pressable>
        <Text className="flex-1 text-xl font-bold text-slate-900">
          Scan asset tag
        </Text>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-10">
        {!permission ? (
          <Loading />
        ) : canUseCamera ? (
          <View className="mb-4 overflow-hidden rounded-2xl bg-black" style={{ height: 300 }}>
            <CameraView
              style={{ flex: 1 }}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => onBarcode(data)}
            />
          </View>
        ) : (
          <View className="mb-4 rounded-2xl border border-slate-200 bg-white p-5">
            <Text className="text-slate-700">
              Camera access is needed to scan tags.
            </Text>
            <View className="mt-3">
              <Button title="Enable camera" onPress={requestPermission} />
            </View>
            <Text className="mt-3 text-xs text-slate-400">
              On some browsers in-app scanning isn't supported — you can scan
              the tag with your phone's camera app instead, or paste the code
              below.
            </Text>
          </View>
        )}

        {resolving ? (
          <Text className="mb-3 text-center text-slate-500">Looking up…</Text>
        ) : null}

        <Text className="mb-1 text-sm font-medium text-slate-600">
          Or enter a code / paste a tag link
        </Text>
        <Field
          label=""
          value={manual}
          onChangeText={setManual}
          placeholder="asset id or https://…/asset/…"
          autoCapitalize="none"
        />
        <Button title="Open asset" onPress={() => resolve(manual)} loading={resolving} />
      </ScrollView>
    </Screen>
  );
}
