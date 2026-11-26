import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text } from "react-native";
import { Button, Field, Loading, Screen } from "../../components/ui";
import { accountActionGuard } from "../../lib/accountActionState";
import { createAccountSession } from "../../lib/accountSession";
import { useAuth } from "../../lib/auth";
import { safeReturnPath } from "../../lib/invites";
import { operationError } from "../../lib/operationsQuery";

export default function ResetPassword() {
  const { session, initializing } = useAuth();
  const router = useRouter();
  const { next } = useLocalSearchParams<{ next?: string }>();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const uid = session?.user.id;
  const [stateUid, setStateUid] = useState(uid);
  const currentUid = useRef(uid);
  const actionLock = useRef(false);
  currentUid.current = uid;

  useEffect(() => {
    setPassword(""); setConfirmation(""); setError(""); setBusy(false);
    setStateUid(uid); actionLock.current = false;
  }, [uid]);

  async function save() {
    if (!session || currentUid.current !== session.user.id || actionLock.current) return;
    setError("");
    if (password.length < 12) { setError("Use at least 12 characters."); return; }
    if (password !== confirmation) { setError("The passwords do not match."); return; }
    const snapshot = session;
    const guard = accountActionGuard(snapshot.user.id, () => currentUid.current);
    const newPassword = password;
    const destination = safeReturnPath(next);
    actionLock.current = true; setBusy(true);
    try {
      const client = createAccountSession(snapshot);
      const { error: sessionError } = await client.auth.setSession({ access_token: snapshot.access_token, refresh_token: snapshot.refresh_token });
      guard(); if (sessionError) throw sessionError;
      const { error: updateError } = await client.auth.updateUser({ password: newPassword });
      guard(); if (updateError) throw updateError;
      setPassword(""); setConfirmation("");
      router.replace(destination as never);
    } catch (cause) {
      if (currentUid.current === snapshot.user.id) setError(operationError(cause));
    } finally {
      if (currentUid.current === snapshot.user.id) { actionLock.current = false; setBusy(false); }
    }
  }
  if (initializing || stateUid !== uid) return <Loading />;
  if (!session) return <Redirect href="/(auth)/login" />;
  return (
    <Screen>
      <ScrollView contentContainerClassName="mx-auto w-full max-w-lg p-6" keyboardShouldPersistTaps="handled">
        <Text className="mb-5 text-2xl font-bold text-slate-900">Choose a new password</Text>
        <Field label="New password (at least 12 characters)" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" editable={!busy} />
        <Field label="Repeat new password" value={confirmation} onChangeText={setConfirmation} secureTextEntry autoComplete="new-password" editable={!busy} onSubmitEditing={save} />
        {error ? <Text accessibilityRole="alert" className="mb-4 text-red-700">{error}</Text> : null}
        <Button title="Save password" onPress={save} loading={busy} />
      </ScrollView>
    </Screen>
  );
}
