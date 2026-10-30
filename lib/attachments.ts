import { decode } from "base64-arraybuffer";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";

import { newRecordId } from "./id";
import { supabase } from "./supabase";
import { ALLOWED_ATTACHMENT_MIME_TYPES, MAX_IMAGE_BYTES, assertStoragePath, assertUploadSize, inspectDocument, inspectImage, safeUploadName } from "./uploadPolicy";

const BUCKET = "attachments";
export type UploadedImage = { storagePath: string; mimeType: string; sizeBytes: number };
export type UploadedDocument = UploadedImage & { name: string };
export type PickedImage = { base64: string; contentType: string; ext: string };

/** Inspect actual encoded bytes; native pickers may convert HEIC to JPEG. */
export function imageBytes(picked: PickedImage): { bytes: ArrayBuffer; mimeType: string } {
  if (!picked.base64 || picked.base64.length % 4 !== 0 || picked.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(picked.base64)) throw new Error("Choose a valid photo no larger than 10 MB.");
  const bytes = decode(picked.base64);
  const detected = inspectImage(new Uint8Array(bytes));
  if (detected.mimeType !== picked.contentType || detected.ext !== picked.ext) throw new Error("The selected file no longer matches its photo type. Choose it again.");
  return { bytes, mimeType: detected.mimeType };
}

export async function pickImageForUpload(): Promise<PickedImage | null> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 0.7 });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  if (!asset.base64 || asset.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error("Choose a photo no larger than 10 MB.");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(asset.base64) || asset.base64.length % 4 !== 0) throw new Error("Could not read the selected image.");
  const detected = inspectImage(new Uint8Array(decode(asset.base64)));
  return { base64: asset.base64, contentType: detected.mimeType, ext: detected.ext };
}

export async function pickAndUploadImage(uid: string, subPath: string): Promise<UploadedImage | null> {
  const picked = await pickImageForUpload();
  if (!picked) return null;
  return uploadPickedImage(`${uid}/${subPath}/${newRecordId()}.${picked.ext}`, picked);
}

export async function pickAndUploadDocument(uid: string, subPath: string): Promise<UploadedDocument | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: ALLOWED_ATTACHMENT_MIME_TYPES, copyToCacheDirectory: true, multiple: false });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  if (asset.size != null) assertUploadSize(asset.size);
  let bytes: ArrayBuffer;
  if (Platform.OS === "web") {
    if (asset.file) {
      assertUploadSize(asset.file.size);
      bytes = await asset.file.arrayBuffer();
    }
    else {
      if (!/^(?:blob:|data:)/.test(asset.uri)) throw new Error("Could not read the selected local file.");
      const response = await fetch(asset.uri);
      if (!response.ok) throw new Error("Could not read the selected file.");
      bytes = await response.arrayBuffer();
    }
  } else {
    if (!/^(?:file:|content:)/.test(asset.uri)) throw new Error("Could not read the selected local file.");
    const file = new File(asset.uri);
    assertUploadSize(file.size);
    bytes = await file.arrayBuffer();
  }
  const detected = inspectDocument(new Uint8Array(bytes), asset.mimeType ?? (Platform.OS === "web" ? asset.file?.type : undefined), asset.name);
  const storagePath = `${uid}/${subPath}/${newRecordId()}.${detected.ext}`;
  assertStoragePath(storagePath);
  const { error } = await supabase.storage.from(BUCKET).upload(storagePath, bytes, { contentType: detected.mimeType, upsert: false });
  if (error) throw error;
  return { storagePath, mimeType: detected.mimeType, sizeBytes: bytes.byteLength, name: safeUploadName(asset.name) };
}

export async function openAttachment(storagePath: string): Promise<void> {
  const url = await signedUrl(storagePath);
  if (!url) throw new Error("The attachment is unavailable. Refresh this screen and try again.");
  await WebBrowser.openBrowserAsync(url);
}

/** Already-issued links cannot be revoked instantly; keep their validity short. */
export async function signedUrl(storagePath: string, expiresIn = 300): Promise<string | null> {
  assertStoragePath(storagePath);
  if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 900) throw new Error("Choose a short-lived attachment link.");
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, expiresIn);
  if (error) throw error;
  return data?.signedUrl ?? null;
}

export async function removeAttachment(storagePath: string): Promise<void> {
  assertStoragePath(storagePath);
  const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
  if (error) throw error;
}

export async function uploadPickedImage(storagePath: string, picked: PickedImage): Promise<UploadedImage> {
  assertStoragePath(storagePath);
  const { bytes, mimeType } = imageBytes(picked);
  if (!storagePath.endsWith(`.${picked.ext}`)) throw new Error("The attachment filename does not match its photo type.");
  const { error } = await supabase.storage.from(BUCKET).upload(storagePath, bytes, { contentType: mimeType, upsert: false });
  if (error) throw error;
  return { storagePath, mimeType, sizeBytes: bytes.byteLength };
}
