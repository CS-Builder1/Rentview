import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Badge, Button, Card, EmptyState, Loading, Screen } from "../../components/ui";
import { useAuth, homeForRole } from "../../lib/auth";
import { operationError, readAllPages } from "../../lib/operationsQuery";
import type { DispatchJob } from "../../lib/dispatchTypes";
import { displayVisit } from "../../lib/dispatchVisit";
import { supabase } from "../../lib/supabase";

export default function ContractorJobs() {
  const router = useRouter();
  const { session, role } = useAuth();
  const [jobs, setJobs] = useState<DispatchJob[] | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useFocusEffect(useCallback(() => {
    let active = true;
    setError("");
    readAllPages<DispatchJob>((from, to) => supabase.rpc("my_dispatch_jobs", {})
      .order("work_order_id").range(from, to)).then(result => {
      if (!active) return;
      if (result.error) setError(operationError(result.error));
      setJobs(result.data ?? []);
    });
    return () => { active = false; };
  }, [session?.user.id, refresh]));
  if (!jobs) return <Loading />;
  const sorted = jobs.slice().sort((a,b) => Number(b.assignment_status === "pending") - Number(a.assignment_status === "pending") ||
    (a.visit_start ?? "z").localeCompare(b.visit_start ?? "z") || a.title.localeCompare(b.title));
  return <Screen><ScrollView contentContainerClassName="mx-auto w-full max-w-2xl gap-3 px-5 py-5">
    <Text className="text-2xl font-bold text-slate-900">Assigned jobs</Text>
    <View className="flex-row flex-wrap gap-2">
      <Button title="Inbox" variant="secondary" onPress={() => router.push("/inbox" as never)} />
      <Button title="Refresh jobs" variant="secondary" onPress={() => setRefresh(n => n + 1)} />
      <Button title="Account" variant="secondary" onPress={() => router.push("/account")} />
    </View>
    {error ? <Text accessibilityRole="alert" className="text-red-700">{error}</Text> :
      sorted.length === 0 ? <EmptyState title="No assigned jobs" subtitle="Jobs appear here when a property manager assigns you." /> : null}
    {sorted.map(job => <Card key={job.work_order_id} onPress={() => router.push(`/contractor/job/${job.work_order_id}`)}>
      <Text className="text-lg font-semibold text-slate-900">{job.title}</Text>
      <Text className="my-1 text-slate-600">{[job.property_name, job.unit_label].filter(Boolean).join(" · ")}</Text>
      <Badge label={job.assignment_status ?? job.work_status} />
      {job.visit_start ? <Text className="mt-2 text-slate-600">{displayVisit(job.visit_start)} · {job.visit_status}</Text> : null}
    </Card>)}
    <Button title="Join another vendor invitation" variant="secondary" onPress={() => router.push("/contractor-invite")} />
    {role !== "contractor" ? <Button title="Return to my home" variant="secondary" onPress={() => router.replace(homeForRole(role))} /> : null}
  </ScrollView></Screen>;
}
