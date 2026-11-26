import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, Share, Text, View } from "react-native";
import { appBaseUrl } from "../lib/appUrl";
import type { ContractorInvitationStatus } from "../lib/dispatchTypes";
import { normalizeInviteCode } from "../lib/invites";
import { operationError } from "../lib/operationsQuery";
import { supabase } from "../lib/supabase";
import { Button } from "./ui";

export function ContractorInviteShare({ vendorId, email }: { vendorId: string; email?: string | null }) {
  const [status, setStatus] = useState<ContractorInvitationStatus | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    const ticket = ++revision.current;
    setStatus(null);
    setError("");
    setMessage("");
    try {
      const result = await supabase.rpc("contractor_invitation_status", {p_vendor: vendorId});
      if (result.error) throw result.error;
      if (!result.data) throw new Error("This vendor is unavailable.");
      if (ticket !== revision.current) return;
      setStatus(result.data);
      if (result.data !== "pending") setCode("");
      return result.data;
    } catch (failure) {
      if (ticket === revision.current) setError(operationError(failure));
    }
  }, [vendorId]);

  useEffect(() => {
    void refresh();
    const listener = AppState.addEventListener("change", state => {
      if (state === "active") void refresh();
    });
    return () => {
      revision.current++;
      listener.remove();
    };
  }, [refresh]);

  async function invite() {
    if (busy || !status || status === "connected") return;
    setBusy(true);
    setMessage("");
    try {
      const { data, error } = await supabase.rpc("create_contractor_invite", { p_vendor: vendorId });
      if (error) throw error;
      const normalized = normalizeInviteCode(data);
      if (!normalized) throw new Error("The invitation could not be created. Try again.");
      revision.current++;
      setStatus("pending");
      setCode(normalized);
    } catch (failure) {
      // The contractor can accept on another device while this editor is open.
      const current = await refresh();
      if (current && current !== "connected") setMessage(operationError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    try {
      const url = `${appBaseUrl()}/contractor-invite?code=${encodeURIComponent(code)}`;
      const invitation = `You have been invited to receive RentView maintenance jobs. Use ${email} to sign in or create an account. Open ${url} or enter contractor code ${code}.`;
      if (Platform.OS === "web") {
        await navigator.clipboard.writeText(invitation);
        setMessage("Invitation copied. Send it privately to the contractor.");
      } else await Share.share({ message: invitation });
    } catch {
      setMessage("Share the code below and ask the contractor to choose ‘I have a contractor invitation’ at sign-in.");
    }
  }

  if (!status) {
    return <View className="my-3 gap-2">
      <Text accessibilityLiveRegion="polite" className="text-slate-700">
        {error || "Checking contractor connection…"}
      </Text>
      {error ? <Button title="Retry contractor connection" variant="secondary" onPress={() => void refresh()} /> : null}
    </View>;
  }

  if (status === "connected") {
    return <Text accessibilityLiveRegion="polite" className="my-3 font-semibold text-slate-800">
      Contractor connected
    </Text>;
  }

  return <View className="my-3 gap-2">
    {email ? <Text className="text-slate-600">Contractor invitation for {email}</Text> :
      <Text className="text-slate-600">Save a vendor email to invite this contractor.</Text>}
    {status === "pending" ? <Text className="text-slate-700">Awaiting contractor acceptance.</Text> : null}
    {code ? <>
      <Text selectable className="font-semibold text-slate-900">{code}</Text>
      <Button title={Platform.OS === "web" ? "Copy contractor invitation" : "Share contractor invitation"} variant="secondary" onPress={() => void share()} />
    </> : <>
      {status === "pending" ? <Text className="text-slate-600">A replacement invitation will invalidate the previous link.</Text> : null}
      <Button title={status === "pending" ? "Replace contractor invitation" : "Create contractor invitation"} variant="secondary" disabled={!email} loading={busy} onPress={() => void invite()} />
    </>}
    {status === "pending" ? <Button title="Refresh invitation status" variant="secondary" disabled={busy} onPress={() => void refresh()} /> : null}
    {message ? <Text accessibilityLiveRegion="polite" className="text-slate-700">{message}</Text> : null}
  </View>;
}
