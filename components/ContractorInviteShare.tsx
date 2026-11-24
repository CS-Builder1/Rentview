import { useState } from "react";
import { Platform, Share, Text, View } from "react-native";
import { appBaseUrl } from "../lib/appUrl";
import { normalizeInviteCode } from "../lib/invites";
import { operationError } from "../lib/operationsQuery";
import { supabase } from "../lib/supabase";
import { Button } from "./ui";

export function ContractorInviteShare({ vendorId, email }: { vendorId: string; email?: string | null }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function invite() {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const { data, error } = await supabase.rpc("create_contractor_invite", { p_vendor: vendorId });
      if (error) throw error;
      const normalized = normalizeInviteCode(data);
      if (!normalized) throw new Error("The invitation could not be created. Try again.");
      setCode(normalized);
    } catch (error) { setMessage(operationError(error)); }
    finally { setBusy(false); }
  }
  async function share() {
    try {
      const url = `${appBaseUrl()}/contractor-invite?code=${encodeURIComponent(code)}`;
      const message = `You have been invited to receive RentView maintenance jobs. Use ${email} to sign in or create an account. Open ${url} or enter contractor code ${code}.`;
      if (Platform.OS === "web") {
        await navigator.clipboard.writeText(message);
        setMessage("Invitation copied. Send it privately to the contractor.");
      } else await Share.share({ message });
    } catch { setMessage("Share the code below and ask the contractor to choose ‘I have a contractor invitation’ at sign-in."); }
  }
  return <View className="my-3 gap-2">
    {email ? <Text className="text-slate-600">Contractor invitation for {email}</Text> :
      <Text className="text-slate-600">Save a vendor email to invite this contractor.</Text>}
    {code ? <>
      <Text selectable className="font-semibold text-slate-900">{code}</Text>
      <Button title={Platform.OS === "web" ? "Copy contractor invitation" : "Share contractor invitation"} variant="secondary" onPress={() => void share()} />
    </> : <Button title="Create contractor invitation" variant="secondary" disabled={!email} loading={busy} onPress={() => void invite()} />}
    {message ? <Text accessibilityLiveRegion="polite" className="text-slate-700">{message}</Text> : null}
  </View>;
}
