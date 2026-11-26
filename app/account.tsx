import { Redirect, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button, Card, Field, Loading, Screen } from "../components/ui";
import { accountActionGuard, canNavigateAfterSignOut } from "../lib/accountActionState";
import { createAccountSession } from "../lib/accountSession";
import { useAuth } from "../lib/auth";
import { operationError } from "../lib/operationsQuery";

export default function Account() {
  const router = useRouter();
  const { session, initializing, role, profileError, refreshProfile, signOut, finishAccountDeletion } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [deletionPending, setDeletionPending] = useState(false);
  const [deletionReview, setDeletionReview] = useState(false);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileReload, setProfileReload] = useState(0);
  const uid = session?.user.id;
  const [stateUid, setStateUid] = useState(uid);
  const currentUid = useRef(uid);
  const actionLock = useRef(false);
  currentUid.current = uid;
  const recoveryMode = Boolean(profileError) || deletionPending || deletionReview || !profileLoaded;

  useEffect(() => {
    // A deletion confirmation or profile draft belongs only to its original user.
    setName(""); setEmail(""); setConfirmation(""); setError(""); setMessage("");
    setDeletionPending(false); setDeletionReview(false); setProfileLoaded(false); setBusy(false);
    setStateUid(uid);
    actionLock.current = false;
  }, [uid]);

  useEffect(() => {
    let active = true;
    if (!session || deletionPending) return;
    const snapshot = session;
    setEmail(snapshot.user.email ?? "");
    setProfileLoaded(false); setProfileLoading(true);
    void (async () => {
      try {
        const client = createAccountSession(snapshot);
        const { data, error: readError } = await client.from("profiles").select("full_name").eq("id", snapshot.user.id).single();
        if (readError) throw readError;
        if (!active || currentUid.current !== snapshot.user.id) return;
        setName(data.full_name ?? ""); setProfileLoaded(true);
      } catch {
        if (active && currentUid.current === snapshot.user.id) setError("Could not load your profile. Retry account access before editing. If you started deletion, you can continue it below.");
      } finally {
        if (active && currentUid.current === snapshot.user.id) setProfileLoading(false);
      }
    })();
    return () => { active = false; };
  // Token refresh does not overwrite a profile draft. A retry captures a fresh session.
  }, [uid, session?.user.email, profileReload, deletionPending]);

  function beginAction() {
    if (!session || actionLock.current) return null;
    const snapshot = session;
    if (currentUid.current !== snapshot.user.id) return null;
    const guard = accountActionGuard(snapshot.user.id, () => currentUid.current);
    guard(); actionLock.current = true; setBusy(true); setError(""); setMessage("");
    return { snapshot, guard };
  }
  function finishAction(expectedUid: string) {
    if (currentUid.current === expectedUid) { actionLock.current = false; setBusy(false); }
  }
  function reportError(expectedUid: string, cause: unknown) {
    if (currentUid.current === expectedUid) setError(operationError(cause));
  }

  async function save() {
    if (recoveryMode) return;
    const action = beginAction(); if (!action) return;
    const { snapshot, guard } = action;
    const nextName = name.trim();
    try {
      const client = createAccountSession(snapshot);
      guard();
      const { data, error: writeError } = await client.from("profiles").update({ full_name: nextName || null }).eq("id", snapshot.user.id).select("id").single();
      guard();
      if (writeError || !data) throw writeError ?? new Error("Your profile was not saved.");
      setMessage("Profile saved.");
    } catch (cause) { reportError(snapshot.user.id, cause); }
    finally { finishAction(snapshot.user.id); }
  }

  async function otherDevices() {
    const action = beginAction(); if (!action) return;
    const { snapshot, guard } = action;
    try {
      const client = createAccountSession(snapshot);
      const { error: sessionError } = await client.auth.setSession({ access_token: snapshot.access_token, refresh_token: snapshot.refresh_token });
      guard(); if (sessionError) throw sessionError;
      const { error: authError } = await client.auth.signOut({ scope: "others" });
      guard(); if (authError) throw authError;
      setMessage("Other sessions were signed out. Existing access tokens expire according to the session policy.");
    } catch (cause) { reportError(snapshot.user.id, cause); }
    finally { finishAction(snapshot.user.id); }
  }

  async function retryAccess() {
    const action = beginAction(); if (!action) return;
    const { snapshot, guard } = action;
    try {
      const restoredRole = await refreshProfile(); guard();
      if (!restoredRole) throw new Error("Account access could not be restored. Check your connection or continue a deletion you already started.");
      setError(""); setProfileReload(value => value + 1);
    } catch (cause) { reportError(snapshot.user.id, cause); }
    finally { finishAction(snapshot.user.id); }
  }

  async function signOutHere() {
    const action = beginAction(); if (!action) return;
    const { snapshot } = action;
    try {
      await signOut();
      if (canNavigateAfterSignOut(snapshot.user.id, currentUid.current)) router.replace("/(auth)/login");
    } catch (cause) { reportError(snapshot.user.id, cause); }
    finally { finishAction(snapshot.user.id); }
  }

  async function remove() {
    if (confirmation !== "DELETE" || deletionReview) return;
    const action = beginAction(); if (!action) return;
    const { snapshot, guard } = action;
    try {
      const client = createAccountSession(snapshot);
      const { data, error: deleteError } = await client.functions.invoke("delete-account");
      guard();
      if (deleteError) {
        const context = (deleteError as { context?: Response }).context;
        let payload: { error?: unknown; message?: unknown; pending?: boolean; requiresReview?: boolean } | undefined;
        try { payload = await context?.json(); } catch { /* Use SDK error below. */ }
        guard();
        if (payload?.pending === true) setDeletionPending(true);
        if (payload?.requiresReview === true) setDeletionReview(true);
        const detail = payload?.error ?? payload?.message;
        throw new Error(typeof detail === "string" && detail ? detail : deleteError.message);
      }
      if (data?.pending) {
        setDeletionPending(true);
        setDeletionReview(data.requiresReview === true);
        setMessage(typeof data.message === "string" ? data.message : "Your files are being removed. Continue deletion to finish.");
        return;
      }
      if (!data?.success) throw new Error(typeof data?.error === "string" ? data.error : "Deletion did not complete. Your account has not been confirmed deleted.");
      guard(); await finishAccountDeletion(snapshot.user.id);
      if (canNavigateAfterSignOut(snapshot.user.id, currentUid.current)) router.replace("/(auth)/login");
    } catch (cause) { reportError(snapshot.user.id, cause); }
    finally { finishAction(snapshot.user.id); }
  }

  if (initializing || stateUid !== uid) return <Loading />;
  if (!session) return <Redirect href="/(auth)/login" />;
  return (
    <Screen>
      <ScrollView contentContainerClassName="mx-auto w-full max-w-2xl p-5 pb-12" keyboardShouldPersistTaps="handled">
        <View className="mb-5"><Button title="Back" variant="secondary" disabled={busy} onPress={() => router.canGoBack() ? router.back() : router.replace("/")} /></View>
        <Text className="mb-4 text-2xl font-bold text-slate-900">Account & security</Text>
        <Text className="mb-4 text-slate-600">Signed in as {session.user.email}</Text>
        {error ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" className="mb-4 text-red-700">{error}</Text> : null}
        {message ? <Text accessibilityLiveRegion="polite" className="mb-4 text-teal-800">{message}</Text> : null}
        {recoveryMode ? (
          <Card>
            <Text className="mb-2 font-semibold text-slate-900">{deletionReview ? "Account deletion needs support review" : deletionPending ? "Account deletion is in progress" : profileLoading ? "Loading account access…" : "Account access needs attention"}</Text>
            <Text className="mb-4 text-slate-600">{deletionReview ? "A previous deletion step could not be confirmed. Contact support to reconcile it before continuing. Return to this screen after support confirms it is safe to continue. Signing out will not cancel deletion." : deletionPending ? "Your profile is unavailable while files are being removed. Continue deletion below to finish. Signing out will not cancel deletion." : profileError || "Profile editing is unavailable until your account can be read. Retry account access, or continue below if you already started deletion."}</Text>
            {!deletionPending ? <Button title="Retry account access" variant="secondary" loading={busy} onPress={retryAccess} /> : null}
          </Card>
        ) : (
          <>
            <Field label="Full name" value={name} onChangeText={setName} maxLength={200} autoComplete="name" editable={!busy} />
            <Text className="mb-1 text-sm font-medium text-slate-600">Email</Text>
            <Text className="mb-2 text-slate-900">{email}</Text>
            <Text className="mb-4 text-sm text-slate-500">Email changes are currently unavailable. Sign-up, sign-in and password recovery remain available for this address.</Text>
            <Button title="Save profile" onPress={save} loading={busy} />
            <View className="mt-4 gap-3">
              <Button title="Change password" variant="secondary" disabled={busy} onPress={() => router.push({ pathname: "/reset-password", params: { next: "/account" } } as never)} />
              <Button title="Sign out other devices" variant="secondary" disabled={busy} onPress={otherDevices} />
              <Button title="My tenant portal" variant="secondary" disabled={busy} onPress={() => router.push("/tenant")} />
              {role === "owner" ? <Button title="Manage my properties" variant="secondary" disabled={busy} onPress={() => router.push("/(app)")} /> : null}
            </View>
          </>
        )}
        <View className="mt-4"><Button title="Sign out this device" variant="secondary" disabled={busy} onPress={signOutHere} /></View>
        <View className="mt-8">
          <Card>
            <Text className="font-semibold text-slate-900">Delete account</Text>
            <Text className="mt-2 text-slate-600">Deletion is permanent and includes your uploaded files. Owners should export required records first. Resolve active billing through your provider before deleting; account deletion must not be treated as proof that a subscription was cancelled.</Text>
            <View className="mt-4">
              <Field label="Type DELETE to confirm" value={confirmation} onChangeText={setConfirmation} autoCapitalize="characters" autoCorrect={false} editable={!busy && !deletionReview} />
              {deletionReview ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" className="mb-3 text-amber-800">Deletion is paused for support review. Further deletion attempts are disabled on this screen.</Text> : null}
              <Button title={deletionReview ? "Deletion needs support review" : deletionPending ? "Continue account deletion" : "Permanently delete account"} variant="danger" onPress={remove} disabled={confirmation !== "DELETE" || deletionReview} loading={busy} />
            </View>
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}
