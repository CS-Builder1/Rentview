import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";

import { NotificationPrefs } from "../../../components/NotificationPrefs";
import { Button, Card, Screen } from "../../../components/ui";
import { useAuth } from "../../../lib/auth";

export default function TenantMore() {
  const router = useRouter();
  const { session, signOut } = useAuth();

  return (
    <Screen>
      <ScrollView contentContainerClassName="px-5 pb-10">
        <Text className="mb-1 mt-2 text-2xl font-bold text-slate-900">More</Text>
        <Text className="mb-5 text-slate-500">{session?.user.email}</Text>

        <Pressable onPress={() => router.push("/claim")}>
          <Card>
            <View className="flex-row items-center">
              <Ionicons name="key-outline" size={20} color="#0f766e" />
              <Text className="ml-3 flex-1 text-base text-slate-700">
                Add another invite code
              </Text>
              <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />
            </View>
          </Card>
        </Pressable>

        <Card>
          <Text className="text-sm font-semibold uppercase text-slate-400">
            What your landlord sees
          </Text>
          <Text className="mt-2 text-slate-600">
            The requests you submit, the photos and messages you add to them,
            and your rating once a repair is done. They do not see anything
            else on this device.
          </Text>
        </Card>

        <NotificationPrefs variant="tenant" />

        <View className="mt-4">
          <Button title="Sign out" variant="secondary" onPress={signOut} />
        </View>
      </ScrollView>
    </Screen>
  );
}
