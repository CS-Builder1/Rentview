import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { supabase } from "./supabase";

/** Expo push only reaches real iOS/Android devices — web and simulators no-op. */
export const PUSH_SUPPORTED = Platform.OS === "ios" || Platform.OS === "android";

export type PushEvent =
  | "request_created"
  | "request_updated"
  | "request_message"
  | "announcement";

/**
 * The EAS project id Expo issues push tokens against. It only exists once the
 * project has been linked (`eas init`), so a local checkout without one simply
 * runs without push instead of crashing.
 */
function easProjectId(): string | undefined {
  const fromConfig = Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof fromConfig === "string") return fromConfig;
  const fromEas = Constants.easConfig?.projectId;
  return typeof fromEas === "string" ? fromEas : undefined;
}

/** How a notification behaves while the app is in the foreground. */
export function configureNotificationHandler(): void {
  if (!PUSH_SUPPORTED) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

async function currentToken(): Promise<string | null> {
  const projectId = easProjectId();
  if (!projectId) return null;
  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    return data;
  } catch {
    return null;
  }
}

/**
 * Ask for permission (once) and store this device's token against the signed-in
 * user. Returns the token, or null when push isn't available — a device that
 * declines is a normal state, not an error.
 */
export async function registerPushToken(): Promise<string | null> {
  if (!PUSH_SUPPORTED || !Device.isDevice) return null;

  const projectId = easProjectId();
  if (!projectId) {
    console.warn(
      "[push] No EAS project id — run `eas init` to enable push notifications.",
    );
    return null;
  }

  const existing = await Notifications.getPermissionsAsync();
  const granted = existing.granted
    ? true
    : (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      importance: Notifications.AndroidImportance.DEFAULT,
      lightColor: "#0f766e",
    });
  }

  const token = await currentToken();
  if (!token) return null;

  // A device can move between accounts, so registration goes through the RPC
  // that reassigns an existing token to the caller.
  const { error } = await supabase.rpc("register_push_token", {
    p_token: token,
    p_platform: Platform.OS,
  });
  if (error) {
    console.warn("[push] Could not register token:", error.message);
    return null;
  }
  return token;
}

/**
 * Drop this device's token on sign-out, so the next person to sign in on a
 * shared phone never receives the previous account's notifications.
 */
export async function unregisterPushToken(): Promise<void> {
  if (!PUSH_SUPPORTED) return;
  const token = await currentToken();
  if (!token) return;
  await supabase.from("push_tokens").delete().eq("token", token);
}

/**
 * Tell the backend that something happened that may deserve a notification.
 * Deliberately fire-and-forget: the recipient is derived server-side, and a
 * failed send must never fail the action the user just took.
 */
export function notifyPush(event: PushEvent, id: string, preview?: string): void {
  void supabase.functions
    .invoke("send-push", { body: { event, id, preview } })
    .catch(() => {
      // Offline or the function is unavailable — the in-app record still stands.
    });
}
