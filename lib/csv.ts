import { Platform } from "react-native";

export { toCsv } from "./csvCore";

/** Save/share text content cross-platform (web download; native share sheet). */
export async function exportText(
  filename: string,
  mimeType: string,
  content: string,
): Promise<void> {
  if (Platform.OS === "web") {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return;
  }

  const FileSystem = await import("expo-file-system/legacy");
  const Sharing = await import("expo-sharing");
  const uri = `${FileSystem.cacheDirectory}${filename}`;
  await FileSystem.writeAsStringAsync(uri, content, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType, dialogTitle: filename });
  }
}
