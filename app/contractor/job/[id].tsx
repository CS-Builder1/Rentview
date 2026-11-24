import { useLocalSearchParams, useRouter } from "expo-router";
import { ScrollView } from "react-native";
import { Button, Screen } from "../../../components/ui";
import { DispatchPanel } from "../../../components/DispatchPanel";

export default function ContractorJobDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Screen><ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="mx-auto w-full max-w-2xl gap-3 px-5 py-5">
    <Button title="Back to assigned jobs" variant="secondary" onPress={() => router.replace("/contractor")} />
    <DispatchPanel workOrderId={id} audience="contractor" />
  </ScrollView></Screen>;
}
