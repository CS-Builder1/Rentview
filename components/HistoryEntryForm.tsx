import { useEffect, useRef, useState } from "react";
import { Modal, ScrollView, Switch, Text, View } from "react-native";
import { useAuth } from "../lib/auth";
import { Button, Card, Field, Screen } from "./ui";
import { HistoryChoices } from "./HistoryChoices";
import { pickAndUploadImage, removeAttachment } from "../lib/attachments";
import { notify } from "../lib/feedback";
import {
  conditions,
  entryKinds,
  inspectionError,
  type Room,
} from "../lib/history";
import { newRecordId } from "../lib/id";
import { localToday, validCalendarDate } from "../lib/maintenance";
import { operationError, readAllPages } from "../lib/operationsQuery";
import { supabase } from "../lib/supabase";

type Props = {
  propertyId: string;
  unitId?: string;
  assetId?: string;
  onClose: () => void;
  onSaved: () => void;
};
const freshRoom = (): Room => ({
  room: "",
  condition: "good",
  notes: "",
  evidence: [],
});

export function HistoryEntryForm({
  propertyId,
  unitId,
  assetId,
  onClose,
  onSaved,
}: Props) {
  const { session } = useAuth();
  const [id] = useState(newRecordId);
  const [date, setDate] = useState(localToday);
  const [kind, setKind] = useState<string>("observation");
  const [phase, setPhase] = useState("routine");
  const [title, setTitle] = useState(""),
    [details, setDetails] = useState(""),
    [observer, setObserver] = useState("");
  const [leaseId, setLeaseId] = useState("");
  const [leases, setLeases] = useState<
    {
      id: string;
      tenant_name: string;
      start_date: string | null;
      status: string;
    }[]
  >([]);
  const [leaseError, setLeaseError] = useState("");
  const [rooms, setRooms] = useState<Room[]>([freshRoom()]);
  const [evidence, setEvidence] = useState<string[]>([]);
  const [followUp, setFollowUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    let present = true;
    if (unitId)
      void readAllPages((from, to) =>
        supabase
          .from("leases")
          .select("id,tenant_name,start_date,status", { count: "exact" })
          .eq("unit_id", unitId)
          .order("start_date", { ascending: false })
          .order("id")
          .range(from, to),
      ).then((result) => {
        if (!present) return;
        if (result.error) setLeaseError(operationError(result.error));
        else setLeases(result.data ?? []);
      });
    return () => {
      present = false;
    };
  }, [unitId]);

  function changeRoom(index: number, values: Partial<Room>) {
    setRooms((current) =>
      current.map((room, i) => (i === index ? { ...room, ...values } : room)),
    );
  }

  async function addPhoto(index?: number) {
    if (!session || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const photo = await pickAndUploadImage(
        "history",
        propertyId + "/" + session.user.id,
      );
      if (!photo) return;
      if (index === undefined)
        setEvidence((prev) => [...prev, photo.storagePath]);
      else
        setRooms((current) =>
          current.map((r, i) =>
            i === index
              ? { ...r, evidence: [...r.evidence, photo.storagePath] }
              : r,
          ),
        );
    } catch (error) {
      notify("Photo could not be attached", operationError(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function cancel() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const paths = [...evidence, ...rooms.flatMap((r) => r.evidence)];
    try {
      await Promise.all(paths.map(removeAttachment));
      onClose();
    } catch (error) {
      notify("Could not discard draft photos", operationError(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (lock.current || !session) return;
    if (!title.trim())
      return notify("Title required", "Give this entry a short title.");
    if (!validCalendarDate(date) || date > localToday())
      return notify(
        "Invalid date",
        "Choose today or an earlier date in YYYY-MM-DD format.",
      );
    const inspection = kind === "inspection";
    if (inspection) {
      const error = inspectionError(rooms);
      if (error) return notify("Check the inspection", error);
      if (phase !== "routine" && !leaseId)
        return notify(
          "Select a tenancy",
          "Link this inspection to the lease for the move.",
        );
    }
    lock.current = true;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("record_property_history", {
        p_id: id,
        p_property: propertyId,
        p_unit: unitId ?? null,
        p_asset: assetId ?? null,
        p_lease: leaseId || null,
        p_kind: kind,
        p_date: date,
        p_title: title,
        p_details: details,
        p_observer: observer,
        p_phase: inspection ? phase : null,
        p_rooms: inspection ? rooms : [],
        p_evidence: evidence,
        p_follow_up: followUp,
      });
      if (error) throw error;
      onSaved();
    } catch (error) {
      notify("History entry could not be saved", operationError(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="slide" onRequestClose={() => void cancel()}>
      <Screen>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="p-5 pb-12"
        >
          <Text className="mb-4 text-xl font-bold text-slate-900">
            Record a history entry
          </Text>
          <HistoryChoices
            label="Event type"
            selected={kind}
            choices={entryKinds}
            disabled={busy || rooms.some((r) => r.evidence.length > 0)}
            onSelect={setKind}
          />
          <Field
            label="Title"
            maxLength={250}
            editable={!busy}
            value={title}
            onChangeText={setTitle}
          />
          <Field
            label="Observed on (YYYY-MM-DD)"
            editable={!busy}
            value={date}
            onChangeText={setDate}
          />
          <Field
            label="Observed by"
            maxLength={250}
            placeholder="Defaults to your account"
            editable={!busy}
            value={observer}
            onChangeText={setObserver}
          />
          {unitId ? (
            <>
              <HistoryChoices
                label="Tenancy"
                selected={leaseId}
                disabled={busy}
                choices={[
                  { value: "", label: "Independent of a tenancy" },
                  ...leases.map((l) => ({
                    value: l.id,
                    label: [l.tenant_name, l.start_date, l.status]
                      .filter(Boolean)
                      .join(" · "),
                  })),
                ]}
                onSelect={setLeaseId}
              />
              {leaseError ? (
                <Text className="mb-2 text-red-700">{leaseError}</Text>
              ) : null}
            </>
          ) : null}
          {kind === "inspection" ? (
            <>
              <HistoryChoices
                label="Inspection"
                choices={
                  unitId ? ["move_in", "routine", "move_out"] : ["routine"]
                }
                selected={phase}
                onSelect={setPhase}
                disabled={busy}
              />
              {rooms.map((room, i) => (
                <Card key={i}>
                  <Field
                    label="Room or area"
                    maxLength={120}
                    editable={!busy}
                    value={room.room}
                    onChangeText={(room) => changeRoom(i, { room })}
                  />
                  <HistoryChoices
                    label="Condition"
                    choices={conditions}
                    selected={room.condition}
                    onSelect={(condition) => changeRoom(i, { condition })}
                    disabled={busy}
                  />
                  <Field
                    label="Finding"
                    maxLength={2000}
                    editable={!busy}
                    value={room.notes}
                    onChangeText={(notes) => changeRoom(i, { notes })}
                    multiline
                  />
                  <Button
                    title={
                      room.evidence.length
                        ? "Add room photo (" +
                          room.evidence.length +
                          " attached)"
                        : "Attach room photo"
                    }
                    disabled={busy || room.evidence.length >= 10}
                    variant="secondary"
                    onPress={() => void addPhoto(i)}
                  />
                  {rooms.length > 1 && !room.evidence.length ? (
                    <Button
                      title="Remove room"
                      disabled={busy}
                      variant="secondary"
                      onPress={() => setRooms(rooms.filter((_, j) => j !== i))}
                    />
                  ) : null}
                </Card>
              ))}
              <Button
                title="Add another room"
                variant="secondary"
                disabled={busy || rooms.length >= 100}
                onPress={() => setRooms([...rooms, freshRoom()])}
              />
            </>
          ) : null}
          <Field
            label="Notes"
            maxLength={10000}
            editable={!busy}
            multiline
            value={details}
            onChangeText={setDetails}
          />
          <Button
            title={
              evidence.length
                ? "Add photo (" + evidence.length + " attached)"
                : "Attach photo"
            }
            disabled={busy || evidence.length >= 10}
            variant="secondary"
            onPress={() => void addPhoto()}
          />
          <View className="my-4 flex-row items-center justify-between">
            <Text>Needs follow-up</Text>
            <Switch
              accessibilityLabel="Needs follow-up"
              value={followUp}
              disabled={busy}
              onValueChange={setFollowUp}
            />
          </View>
          <View className="gap-2">
            <Button
              title="Save entry"
              onPress={() => void save()}
              loading={busy}
            />
            <Button
              title="Cancel"
              variant="secondary"
              disabled={busy}
              onPress={() => void cancel()}
            />
          </View>
        </ScrollView>
      </Screen>
    </Modal>
  );
}
