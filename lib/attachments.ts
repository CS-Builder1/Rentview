import { decode } from "base64-arraybuffer";
import * as ImagePicker from "expo-image-picker";

import { supabase } from "./supabase";

const BUCKET = "attachments";

export type UploadedImage = {
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
};

/**
 * Launch the image library, then upload the chosen image to the private
 * `attachments` bucket under `<uid>/<subPath>/<timestamp>.<ext>`.
 * Returns null if the user cancels. Works on web and native via base64.
 */
export async function pickAndUploadImage(
  uid: string,
  subPath: string,
): Promise<UploadedImage | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    base64: true,
    quality: 0.7,
  });
  if (result.canceled || !result.assets?.length) return null;

  const asset = result.assets[0];
  if (!asset.base64) throw new Error("Could not read the selected image.");

  const bytes = decode(asset.base64);
  const mimeType = asset.mimeType ?? "image/jpeg";
  const ext = mimeType.split("/")[1] ?? "jpg";
  const storagePath = `${uid}/${subPath}/${Date.now()}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, bytes, { contentType: mimeType, upsert: false });
  if (error) throw error;

  return { storagePath, mimeType, sizeBytes: bytes.byteLength };
}

/** Create a short-lived signed URL to display a private object. */
export async function signedUrl(
  storagePath: string,
  expiresIn = 3600,
): Promise<string | null> {
  const { data } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresIn);
  return data?.signedUrl ?? null;
}

export async function removeAttachment(storagePath: string): Promise<void> {
  await supabase.storage.from(BUCKET).remove([storagePath]);
}
