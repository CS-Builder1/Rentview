import "../global.css";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { PushNotifications } from "../components/PushNotifications";
import { AuthProvider } from "../lib/auth";
import { OfflineProvider } from "../lib/offline";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <OfflineProvider>
            <StatusBar style="dark" />
            <PushNotifications />
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="(auth)" />
              <Stack.Screen name="(app)" />
              <Stack.Screen name="tenant" />
              <Stack.Screen name="claim" />
            </Stack>
          </OfflineProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
