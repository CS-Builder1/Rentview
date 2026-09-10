import { useRouter, type Href } from "expo-router";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";

import { useAuth } from "../lib/auth";
import {
  PUSH_SUPPORTED,
  configureNotificationHandler,
  registerPushToken,
} from "../lib/push";

configureNotificationHandler();

/**
 * Registers this device once a session exists and routes notification taps to
 * the screen the notification is about. Renders nothing.
 */
export function PushNotifications() {
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (!PUSH_SUPPORTED || !userId) return;
    registerPushToken();
  }, [userId]);

  useEffect(() => {
    if (!PUSH_SUPPORTED || !userId) return;

    const go = (data: unknown) => {
      const url = (data as { url?: unknown } | undefined)?.url;
      if (typeof url === "string" && url.startsWith("/")) {
        router.push(url as Href);
      }
    };

    // Tapped while the app was running.
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => go(response.notification.request.content.data),
    );

    // Tapped to launch the app from cold.
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) go(response.notification.request.content.data);
    });

    return () => subscription.remove();
  }, [router, userId]);

  return null;
}
