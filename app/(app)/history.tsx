import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ScrollView, Switch, Text, View } from "react-native";

import { HistoryChoices } from "../../components/HistoryChoices";
import { HistoryEntryForm } from "../../components/HistoryEntryForm";
import { Button, Card, Field, Loading, Screen } from "../../components/ui";
import { openAttachment } from "../../lib/attachments";
import { useAuth } from "../../lib/auth";
import { exportText, toCsv } from "../../lib/csv";
import { notify } from "../../lib/feedback";
import { formatCurrency, formatDate, titleCase } from "../../lib/format";
import {
  compareRooms,
  filterHistory,
  type HistoryEvent,
  type Room,
} from "../../lib/history";
import { localToday, validCalendarDate } from "../../lib/maintenance";
import { operationError, readAllPages } from "../../lib/operationsQuery";
import { supabase } from "../../lib/supabase";

function Evidence({ paths }: { paths: string[] }) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {paths.map((path, i) => (
        <Button
          key={path}
          title={"Open attachment " + (i + 1)}
          variant="secondary"
          onPress={() =>
            void openAttachment(path).catch((error) =>
              notify("Could not open attachment", operationError(error)),
            )
          }
        />
      ))}
    </View>
  );
}
function RoomFinding({ room }: { room?: Room }) {
  if (!room) return <Text className="text-slate-500">No observation</Text>;
  return (
    <View>
      <Text className="text-slate-800">
        {titleCase(room.condition)}
        {room.notes ? " · " + room.notes : ""}
      </Text>
      <Evidence paths={room.evidence} />
    </View>
  );
}
const inspectionLabel = (e: HistoryEvent) =>
  [e.event_date, e.scope_label, e.title].join(" · ");
const sameLocation = (a: HistoryEvent, b: HistoryEvent) =>
  a.property_id === b.property_id &&
  a.unit_id === b.unit_id &&
  a.asset_id === b.asset_id;
function InspectionComparison({ events }: { events: HistoryEvent[] }) {
  const [first, setFirst] = useState(""),
    [second, setSecond] = useState("");
  const byDate = [...events].reverse();
  const baseline = byDate.find((e) => e.id === first);
  const later = baseline
    ? byDate.filter(
        (e) =>
          e.id !== first &&
          e.event_date >= baseline.event_date &&
          sameLocation(e, baseline),
      )
    : [];
  const followUp = later.find((e) => e.id === second);
  return (
    <Card>
      <HistoryChoices
        label="Earlier inspection"
        choices={byDate.map((e) => ({
          value: e.id,
          label: inspectionLabel(e),
        }))}
        selected={first}
        onSelect={(id) => {
          setFirst(id);
          setSecond("");
        }}
      />
      {baseline &&
        (later.length ? (
          <HistoryChoices
            label="Later inspection at this location"
            selected={second}
            choices={later.map((e) => ({
              value: e.id,
              label: inspectionLabel(e),
            }))}
            onSelect={setSecond}
          />
        ) : (
          <Text>No later inspection is recorded at this location.</Text>
        ))}
      {baseline && followUp
        ? compareRooms(baseline.rooms, followUp.rooms).map((row) => (
            <View
              key={row.room}
              className="mb-3 border-t border-slate-200 pt-2"
            >
              <Text className="font-bold">{row.room}</Text>
              <Text className="mt-1 text-slate-500">
                {formatDate(baseline.event_date)}
              </Text>
              <RoomFinding room={row.before} />
              <Text className="mt-1 text-slate-500">
                {formatDate(followUp.event_date)}
              </Text>
              <RoomFinding room={row.after} />
            </View>
          ))
        : null}
    </Card>
  );
}

export default function PropertyHistory() {
  const router = useRouter();
  const { session } = useAuth();
  const { propertyId, unitId, assetId } = useLocalSearchParams<{
    propertyId: string;
    unitId?: string;
    assetId?: string;
  }>();
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [name, setName] = useState(""),
    [kind, setKind] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [search, setSearch] = useState(""),
    [openOnly, setOpenOnly] = useState(false);
  const [compare, setCompare] = useState(false),
    [adding, setAdding] = useState(false),
    [show, setShow] = useState(50);
  const [revision, setRevision] = useState(0);
  const reload = () => setRevision((v) => v + 1);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setLoading(true);
      setError("");
      setEvents([]);
      setName("");
      setShow(50);
      async function load() {
        if (!session || !propertyId)
          throw new Error("Open history from a property, unit or asset.");
        const context = assetId
          ? supabase
              .from("assets")
              .select("name")
              .eq("id", assetId)
              .eq("property_id", propertyId)
              .single()
          : unitId
            ? supabase
                .from("units")
                .select("name:label")
                .eq("id", unitId)
                .eq("property_id", propertyId)
                .single()
            : supabase
                .from("properties")
                .select("name")
                .eq("id", propertyId)
                .single();
        const [scope, result] = await Promise.all([
          context,
          readAllPages((start, end) => {
            let q = supabase
              .from("property_event_history")
              .select("*", { count: "exact" })
              .eq("property_id", propertyId);
            if (unitId) q = q.eq("unit_id", unitId);
            if (assetId) q = q.eq("asset_id", assetId);
            return q
              .order("event_date", { ascending: false })
              .order("id")
              .range(start, end);
          }),
        ]);
        if (scope.error || result.error) throw scope.error ?? result.error;
        if (!active) return;
        const rows = (result.data ?? []).map((e) =>
          e.event_time
            ? { ...e, event_date: localToday(new Date(e.event_time)) }
            : e,
        );
        rows.sort(
          (a, b) =>
            b.event_date.localeCompare(a.event_date) ||
            (b.event_time ?? "").localeCompare(a.event_time ?? "") ||
            a.id.localeCompare(b.id),
        );
        setName(scope.data?.name ?? "");
        setEvents(rows);
      }
      void load()
        .catch((e) => {
          if (active) setError(operationError(e));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
      return () => {
        active = false;
      };
    }, [propertyId, unitId, assetId, session?.user.id, revision]),
  );
  const dateError = !!(
    (from && !validCalendarDate(from)) ||
    (to && !validCalendarDate(to)) ||
    (from && to && from > to)
  );
  const filtered = useMemo(
    () =>
      dateError
        ? []
        : filterHistory(events, { kind, from, to, search, openOnly }),
    [events, kind, from, to, search, openOnly, dateError],
  );
  const inspections = events.filter((e) => e.kind === "inspection");

  async function exportHistory() {
    try {
      const csv = toCsv(
        [
          "Date",
          "Type",
          "Location",
          "Title",
          "Notes",
          "Observed by",
          "Recorded by",
          "Needs follow-up",
          "Amount",
          "Currency",
          "Inspection",
          "Room observations and photo references",
          "Attachments",
          "Source ID",
          "Work order",
          "Request",
        ],
        filtered.map((e) => [
          e.event_date,
          e.kind,
          e.scope_label,
          e.title,
          e.details,
          e.observer,
          e.recorded_by,
          e.unresolved ? "Yes" : "No",
          e.amount,
          e.currency,
          e.phase,
          e.rooms.length ? JSON.stringify(e.rooms) : "",
          e.evidence.join("\n"),
          e.id,
          e.job_id,
          e.request_id,
        ]),
      );
      await exportText(
        "rentview-history-" + (assetId ?? unitId ?? propertyId) + ".csv",
        "text/csv",
        csv,
      );
    } catch (e) {
      notify("Could not export history", operationError(e));
    }
  }
  async function resolve(id: string) {
    const { error } = await supabase.rpc("resolve_property_history", {
      p_id: id,
    });
    if (error) notify("Could not resolve entry", error.message);
    else reload();
  }
  return (
    <Screen>
      <ScrollView
        contentContainerClassName="px-5 py-4 pb-12"
        keyboardShouldPersistTaps="handled"
      >
        <Button
          title="Back"
          variant="secondary"
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/properties")
          }
        />
        <Text className="mt-4 text-2xl font-bold text-slate-900">
          Condition &amp; repair history
        </Text>
        <Text className="mb-3 text-slate-600">{name}</Text>
        {loading ? (
          <Loading />
        ) : error ? (
          <Card>
            <Text className="mb-2 text-red-700">{error}</Text>
            <Button title="Retry" onPress={reload} />
          </Card>
        ) : (
          <>
            <View className="mb-3 flex-row flex-wrap gap-2">
              <Button title="Record entry" onPress={() => setAdding(true)} />
              <Button
                title="Export filtered history"
                variant="secondary"
                disabled={!filtered.length}
                onPress={() => void exportHistory()}
              />
              {inspections.length >= 2 ? (
                <Button
                  title={compare ? "Close comparison" : "Compare inspections"}
                  variant="secondary"
                  onPress={() => setCompare(!compare)}
                />
              ) : null}
            </View>
            {compare && inspections.length >= 2 ? (
              <InspectionComparison events={inspections} />
            ) : null}
            <Field
              label="Search history"
              value={search}
              onChangeText={setSearch}
              placeholder="Room, contractor, finding or job"
            />
            <HistoryChoices
              label="Event type"
              selected={kind}
              choices={[
                { value: "", label: "All events" },
                ...Array.from(new Set(events.map((e) => e.kind))).sort(),
              ]}
              onSelect={setKind}
            />
            <View className="flex-row gap-2">
              <View className="flex-1">
                <Field
                  label="From"
                  value={from}
                  onChangeText={setFrom}
                  placeholder="YYYY-MM-DD"
                />
              </View>
              <View className="flex-1">
                <Field
                  label="Through"
                  value={to}
                  onChangeText={setTo}
                  placeholder="YYYY-MM-DD"
                />
              </View>
            </View>
            {dateError ? (
              <Text className="text-red-700">
                Enter a valid date range in YYYY-MM-DD format.
              </Text>
            ) : null}
            <View className="mb-4 flex-row items-center justify-between">
              <Text>Needs follow-up only</Text>
              <Switch
                accessibilityLabel="Needs follow-up only"
                value={openOnly}
                onValueChange={setOpenOnly}
              />
            </View>
            <Text className="mb-2 font-semibold">
              {filtered.length} matching{" "}
              {filtered.length === 1 ? "event" : "events"}
            </Text>
            {filtered.slice(0, show).map((e) => (
              <Card key={e.id}>
                <Text className="text-sm text-slate-600">
                  {formatDate(e.event_date)} · {titleCase(e.kind)}
                  {e.phase ? " · " + titleCase(e.phase) : ""}
                </Text>
                <Text className="mt-1 font-bold text-slate-900">{e.title}</Text>
                <Text className="text-slate-600">{e.scope_label}</Text>
                {e.details ? (
                  <Text className="my-1 text-slate-800">{e.details}</Text>
                ) : null}
                {e.observer ? <Text>Observed by {e.observer}</Text> : null}
                {e.recorded_by && e.recorded_by !== e.observer ? (
                  <Text>Recorded by {e.recorded_by}</Text>
                ) : null}
                {e.amount != null ? (
                  <Text>
                    {formatCurrency(e.amount, e.currency ?? undefined)}
                  </Text>
                ) : null}
                {e.unresolved ? (
                  <Text className="my-1 font-medium text-amber-700">
                    Needs follow-up
                  </Text>
                ) : null}
                {e.rooms.map((room) => (
                  <View className="mt-2" key={room.room}>
                    <Text className="font-semibold">{room.room}</Text>
                    <RoomFinding room={room} />
                  </View>
                ))}
                <Evidence paths={e.evidence} />
                <View className="mt-2 flex-row flex-wrap gap-2">
                  {e.job_id ? (
                    <Button
                      title="Open work order"
                      variant="secondary"
                      onPress={() => router.push(`/work-order/${e.job_id}`)}
                    />
                  ) : null}
                  {e.request_id ? (
                    <Button
                      title="Open request"
                      variant="secondary"
                      onPress={() => router.push(`/request/${e.request_id}`)}
                    />
                  ) : null}
                  {e.unresolved && e.manual_id ? (
                    <Button
                      title="Mark resolved"
                      onPress={() => void resolve(e.manual_id!)}
                    />
                  ) : null}
                </View>
              </Card>
            ))}
            {filtered.length > show ? (
              <Button
                title="Show more events"
                variant="secondary"
                onPress={() => setShow(show + 50)}
              />
            ) : null}
          </>
        )}
      </ScrollView>
      {adding ? (
        <HistoryEntryForm
          propertyId={propertyId}
          unitId={unitId}
          assetId={assetId}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      ) : null}
    </Screen>
  );
}
