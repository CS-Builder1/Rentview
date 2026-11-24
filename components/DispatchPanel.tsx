import { useFocusEffect } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Badge, Button, Card, Field } from "./ui";
import { useAuth } from "../lib/auth";
import { imageBytes, pickImageForUpload, type PickedImage } from "../lib/attachments";
import { newRecordId } from "../lib/id";
import { displayVisit, visitWindow } from "../lib/dispatchVisit";
import type { DispatchAction, DispatchJob } from "../lib/dispatchTypes";
import { operationError } from "../lib/operationsQuery";
import { supabase } from "../lib/supabase";

type Audience = "owner" | "tenant" | "contractor";
type VendorOption = { id: string; name: string; owner_id: string; property_id?: string | null };
type Props = {
  audience: Audience;
  workOrderId?: string;
  requestId?: string;
  vendors?: VendorOption[];
  ownerId?: string;
  propertyId?: string;
  onChange?: () => void;
};
type ProofPhoto = { id: string; picked: PickedImage; path?: string };

export function DispatchPanel(props: Props) {
  const { session } = useAuth();
  if (!session) return null;
  const identity = [session.user.id, props.workOrderId, props.requestId, props.audience].join("/");
  return <DispatchDetails key={identity} {...props} userId={session.user.id} />;
}

function DispatchDetails({ audience, userId, workOrderId, requestId, vendors, ownerId, propertyId, onChange }: Props & { userId: string }) {
  const [job, setJob] = useState<DispatchJob | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [editingVisit, setEditingVisit] = useState(false);
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<ProofPhoto[]>([]);
  const [assigning, setAssigning] = useState(false);
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const inFlight = useRef(false);
  const photoBucket = supabase.storage.from("dispatch-photos");

  useFocusEffect(useCallback(() => {
    let active = true;
    let sequence = 0;
    async function read() {
      const attempt = ++sequence;
      try {
        const source = audience === "contractor" ? supabase.rpc("my_dispatch_jobs", {}) : supabase.from("dispatch_jobs").select("*");
        const filter = requestId ? source.eq("request_id", requestId) : source.eq("work_order_id", workOrderId ?? "");
        const { data, error } = await filter.maybeSingle();
        if (error) throw error;
        if (active && attempt === sequence) setJob(data);
      } catch (err) {
        if (active && attempt === sequence) { setJob(null); setError(operationError(err)); }
      } finally {
        if (active && attempt === sequence) setLoaded(true);
      }
    }
    void read();
    const interval = setInterval(() => void read(), 45000);
    return () => { active = false; clearInterval(interval); };
  }, [audience, requestId, workOrderId, refresh]));

  async function perform(operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try { await operation(); }
    catch (err) { setError(operationError(err)); }
    finally { inFlight.current = false; setBusy(false); setRefresh(n => n + 1); }
  }

  async function act(action: DispatchAction) {
    if (!job) return;
    await perform(async () => {
      const window = action === "propose" ? visitWindow(start, end) : {};
      const paths: string[] = [];
      if (action === "complete") {
        if (!notes.trim()) throw new Error("Describe the repair before submitting completion.");
        for (const photo of photos) {
          if (!photo.path) {
            const path = `${job.work_order_id}/${userId}/${photo.id}.${photo.picked.ext}`;
            const { bytes, mimeType } = imageBytes(photo.picked);
            const { error: uploadError } = await photoBucket.upload(path, bytes, { contentType: mimeType, upsert: false });
            if (uploadError) throw uploadError;
            // Retain successful uploads if a later photo or completion request needs a retry.
            photo.path = path;
          }
          paths.push(photo.path);
        }
      }
      const { error } = await supabase.rpc("act_on_dispatch", {
        p_work_order: job.work_order_id, p_revision: job.revision, p_action: action, ...window,
        ...(action === "reopen" ? { p_notes: notes.trim() } : {}),
        ...(action === "complete" ? { p_notes: notes.trim(), p_photos: paths } : {}),
      });
      if (error) throw error;
      setEditingVisit(false);
      setPhotos([]); setNotes("");
      onChange?.();
    });
  }

  async function saveAssignment() {
    if (!job) return;
    await perform(async () => {
      const { error } = await supabase.rpc("assign_dispatch", {
        p_work_order: job.work_order_id, p_vendor: vendorId, p_instructions: instructions.trim() || null,
      });
      if (error) throw error;
      setAssigning(false);
      onChange?.();
    });
  }

  async function addPhoto() {
    await perform(async () => {
      const picked = await pickImageForUpload();
      if (picked) setPhotos(items => [...items, { picked, id: newRecordId() }]);
    });
  }

  async function openPhoto(path: string) {
    await perform(async () => {
      const { data, error } = await photoBucket.createSignedUrl(path, 180);
      if (error) throw error;
      await WebBrowser.openBrowserAsync(data.signedUrl);
    });
  }

  if (!job) {
    if (!loaded) return <Text className="my-2 text-slate-500">Loading visit details…</Text>;
    if (audience === "tenant" && !error) return null;
    return <Card><Text accessibilityRole="alert" className="mb-2 text-slate-700">{error || "This assignment is unavailable."}</Text>
      <Button title="Refresh visit details" variant="secondary" onPress={() => { setError(""); setRefresh(n => n + 1); }} /></Card>;
  }
  const assigned = !!job.vendor_id;
  const accepted = job.assignment_status === "accepted";
  const closed = job.work_status === "cancelled" || job.work_status === "completed";
  const available = (vendors ?? []).filter(v => v.owner_id === ownerId && (!v.property_id || v.property_id === propertyId));

  return <Card><View className="gap-3">
    <Text className="text-xl font-bold text-slate-900">{audience === "contractor" ? job.title : "Contractor and visit"}</Text>
    {audience === "contractor" ? <>
      <Text className="font-medium text-slate-700">{[job.property_name, job.unit_label, job.address].filter(Boolean).join(" · ")}</Text>
      <Badge label={job.priority} />
      {job.description ? <Text className="text-slate-700">{job.description}</Text> : null}
    </> : null}
    <Text className="text-slate-800">{job.vendor_name ?? "No contractor assigned"}</Text>
    {job.assignment_status ? <View className="flex-row items-center gap-2"><Text className="text-slate-600">Assignment</Text><Badge label={job.assignment_status} /></View> : null}
    {job.instructions ? <Text className="text-slate-700">Visit instructions: {job.instructions}</Text> : null}
    {audience === "owner" && assigned && !job.vendor_linked && !closed ? <Text className="text-amber-800">This vendor has not joined. Open Vendors to share their contractor invitation.</Text> : null}
    {error ? <Text accessibilityRole="alert" className="text-red-700">{error}</Text> : null}

    {audience === "owner" && !closed && job.assignment_status !== "completed" ? (
      assigning ? <View className="gap-2">
        <Button title={vendorId ? "Unassign" : "Unassigned (selected)"} variant="secondary" disabled={busy} onPress={() => setVendorId(null)} />
        {available.map(v => <Button key={v.id} title={v.name + (vendorId === v.id ? " (selected)" : "")} variant="secondary" disabled={busy} onPress={() => setVendorId(v.id)} />)}
        {vendorId ? <Field label="Visit instructions shared with the contractor and tenant" multiline value={instructions} onChangeText={setInstructions} maxLength={2000} /> : null}
        <Button title="Save assignment" onPress={() => void saveAssignment()} loading={busy} />
        <Button title="Cancel assignment change" variant="secondary" onPress={() => setAssigning(false)} disabled={busy} />
      </View> : <Button title={assigned ? "Change assignment or instructions" : "Assign contractor"} variant="secondary" onPress={() => {
        setVendorId(job.vendor_id); setInstructions(job.instructions ?? ""); setAssigning(true);
      }} />
    ) : null}
    {audience === "contractor" && job.assignment_status === "pending" && !closed ? <View className="gap-2">
      <Button title="Accept job" onPress={() => void act("accept")} loading={busy} />
      <Button title="Decline job" variant="secondary" onPress={() => void act("decline")} disabled={busy} />
    </View> : null}

    {job.visit_start && job.visit_end ? <View className="gap-1">
      <Text className="font-semibold text-slate-900">{job.visit_status === "confirmed" ? "Confirmed visit" : "Proposed visit"}</Text>
      <Text className="text-slate-700">{displayVisit(job.visit_start)} – {displayVisit(job.visit_end)}</Text>
    </View> : null}
    {accepted && !closed ? <View className="gap-2">
      {job.can_confirm && job.visit_status === "proposed" ? <Button title="Confirm visit window" onPress={() => void act("confirm")} loading={busy} /> : null}
      {editingVisit ? <>
        <Text className="text-slate-600">Enter times in {Intl.DateTimeFormat().resolvedOptions().timeZone}.</Text>
        <Field label="Visit starts" placeholder="YYYY-MM-DD HH:MM" value={start} onChangeText={setStart} autoCapitalize="none" />
        <Field label="Visit ends" placeholder="YYYY-MM-DD HH:MM" value={end} onChangeText={setEnd} autoCapitalize="none" />
        <Button title="Send visit proposal" onPress={() => void act("propose")} loading={busy} />
        <Button title="Cancel proposal" variant="secondary" onPress={() => setEditingVisit(false)} disabled={busy} />
      </> : <Button title={job.visit_status === "none" ? "Propose visit window" : "Propose a different time"} variant="secondary" onPress={() => setEditingVisit(true)} />}
    </View> : null}

    {audience === "owner" && job.assignment_status === "completed" && !closed ? <View className="gap-2">
      <Text className="text-slate-700">The contractor has reported completion. Review their notes, then use Completed above to post costs or return the repair for further work.</Text>
      <Field label="Reason for returning the repair" value={notes} onChangeText={setNotes} maxLength={2000} />
      <Button title="Reopen field repair" variant="secondary" disabled={!notes.trim() || busy} onPress={() => void act("reopen")} />
    </View> : null}
    {audience === "contractor" && accepted && !closed ? <View className="gap-2">
      <Text className="text-slate-700">Work status: {job.work_status.replace(/_/g, " ")}</Text>
      {job.work_status !== "in_progress" ? <Button title="Start repair" variant="secondary" disabled={busy} onPress={() => void act("start")} /> : null}
      <Field label="Completion notes" multiline maxLength={2000} value={notes} onChangeText={setNotes} placeholder="What was repaired and what should the resident know?" />
      {photos.length ? <Text className="text-slate-600">{photos.length} completion photo{photos.length === 1 ? "" : "s"} ready</Text> : null}
      {photos.length < 5 ? <Button title="Add completion photo" onPress={() => void addPhoto()} variant="secondary" disabled={busy} /> : null}
      <Button title="Submit completed repair" onPress={() => void act("complete")} loading={busy} />
    </View> : null}
    {job.field_completed_at ? <Text className="text-slate-700">Repair completed {displayVisit(job.field_completed_at)}</Text> : null}
    {job.completion_notes ? <View className="gap-1"><Text className="font-semibold text-slate-900">Completion notes</Text>
      <Text className="text-slate-700">{job.completion_notes}</Text></View> : null}
    {job.completion_photos.map((path, index) => <Button key={path} title={`View completion photo ${index + 1}`} variant="secondary" onPress={() => void openPhoto(path)} disabled={busy} />)}
  </View></Card>;
}
