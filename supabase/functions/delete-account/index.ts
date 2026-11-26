// Authenticated, retryable deletion. A service-only token claim
// serializes name-based Storage cleanup. Unknown destructive outcomes stay
// blocked for operator review; a clock must never let a second worker overtake
// an old Storage request that can still delete a replacement at the same name.
import { createClient } from "jsr:@supabase/supabase-js@2.109.0";
import { errorResponse, HttpError, json } from "../_shared/http.ts";

// Both SDKs can return network failures in their error field. Auth even uses
// AuthRetryableFetchError for GoTrue's terminal HTTP 500 database refusal.
// A missing response or gateway timeout cannot acknowledge a destructive call.
function confirmedProviderRejection(error: { name: string; status?: number }): boolean {
  const { name, status } = error;
  if (name !== "AuthApiError" && name !== "AuthRetryableFetchError" && name !== "StorageApiError") return false;
  if (typeof status !== "number" || status < 400 || status > 599) return false;
  return ![408, 499, 502, 503, 504].includes(status) && !(status >= 520 && status <= 530);
}

Deno.serve(async req => {
  let worker: { admin: ReturnType<typeof createClient>; userId: string; token: string } | null = null;
  let destructivePending = false;
  try {
    if (req.method === "OPTIONS") return json({ ok: true }, 200, true);
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const authorization = req.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Invalid session");
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const jwt = authorization.slice(7);
    const { data: identity, error: identityError } = await admin.auth.getUser(jwt);
    if (identityError || !identity.user) throw new HttpError(401, "Invalid session");
    const userId = identity.user.id;
    const { error: prepareError } = await admin.rpc("prepare_identity_deletion", { p_owner_id: userId });
    if (prepareError) {
      if (prepareError.code === "P0001") throw new HttpError(409, "Billing must be cancelled and verified before deleting this account. Contact support if billing needs reconciliation.");
      throw prepareError;
    }
    const token = crypto.randomUUID();
    const { data: claimed, error: claimError } = await admin.rpc("claim_identity_deletion_worker", { p_owner_id: userId, p_claim_token: token });
    if (claimError) throw claimError;
    if (claimed !== "claimed") {
      const review = claimed === "needs_review";
      return json({ pending: true, requiresReview: review, code: review ? "deletion_review_required" : "deletion_in_progress",
        error: review ? "A previous deletion step has an unknown outcome. Contact support to reconcile it before continuing."
          : "Deletion is already running. Wait for that action to finish. If this status persists, contact support before continuing." }, 409, true);
    }
    worker = { admin, userId, token };
    const claimArgs = { p_owner_id: userId, p_claim_token: token };
    async function beginDestructiveStep() {
      // Mark uncertain locally before RPC dispatch: a lost response can mean the
      // persistent step started. Never release this claim on an unknown outcome.
      destructivePending = true;
      const { data, error } = await admin.rpc("begin_identity_deletion_step", claimArgs);
      if (error) throw error;
      if (data === false) {
        destructivePending = false;
        throw new HttpError(409, "Another deletion attempt owns this action. Try again after it finishes.");
      }
      if (data !== true) throw new Error("Deletion step could not be confirmed");
    }
    async function finishDestructiveStep() {
      const { data, error } = await admin.rpc("finish_identity_deletion_step", claimArgs);
      if (error || data !== true) throw error ?? new HttpError(409, "Deletion completion could not be confirmed. Contact support before continuing.");
      destructivePending = false;
    }
    async function providerRejection(error: { name: string; status?: number }) {
      if (!confirmedProviderRejection(error)) throw error;
      await finishDestructiveStep();
      return json({ pending: true, requiresReview: false, code: "deletion_retryable",
        error: "The service could not complete deletion. Try again to continue." }, 503, true);
    }
    const deadline = Date.now() + 70_000;
    let removed = 0;
    for (;;) {
      const { data: paths, error: pathsError } = await admin.rpc("owned_storage_paths", { ...claimArgs, p_limit: 100 });
      if (pathsError) throw pathsError;
      if (!paths?.length) break;
      if (Date.now() > deadline || removed >= 2000) return json({ pending: true, removed, message: "Deletion is in progress. Continue this action to finish removing your uploads." }, 202, true);
      const buckets = new Map<string, string[]>();
      for (const item of paths as { bucket_id: string; name: string }[]) buckets.set(item.bucket_id, [...(buckets.get(item.bucket_id) ?? []), item.name]);
      for (const [bucket, names] of buckets) {
        await beginDestructiveStep();
        const { error } = await admin.storage.from(bucket).remove(names);
        if (error) return await providerRejection(error);
        await finishDestructiveStep();
        if (bucket === "attachments") {
          const { error: metadataError } = await admin.rpc("forget_deleted_uploads", { ...claimArgs, p_paths: names });
          if (metadataError) throw metadataError;
        }
        removed += names.length;
      }
    }
    // Provider state can change during cleanup. The Auth-delete trigger also
    // guards the final transaction against concurrent billing activation.
    const { error: finalPrepareError } = await admin.rpc("prepare_identity_deletion", { p_owner_id: userId });
    if (finalPrepareError) {
      if (finalPrepareError.code === "P0001") throw new HttpError(409, "Your billing state changed during deletion. Cancel and verify it with your payment provider, then continue deletion.");
      throw finalPrepareError;
    }
    await beginDestructiveStep();
    const { error: deletionError } = await admin.auth.admin.deleteUser(userId);
    if (deletionError) return await providerRejection(deletionError);
    // Successful Auth deletion cascades the private claim. No old cleanup HTTP
    // request is outstanding, and remaining unexpired JWTs fail the DB guard.
    destructivePending = false;
    worker = null;
    await admin.auth.admin.signOut(jwt, "global").catch(() => undefined);
    return json({ success: true }, 200, true);
  } catch (error) {
    if (worker && destructivePending) {
      try { await worker.admin.rpc("mark_identity_deletion_uncertain", { p_owner_id: worker.userId, p_claim_token: worker.token }); } catch { /* The existing exclusive claim remains blocked. */ }
      return json({ pending: true, requiresReview: true, code: "deletion_review_required",
        error: "A deletion step has an unknown outcome. Contact support to reconcile it before continuing." }, 409, true);
    }
    return errorResponse(error, true);
  } finally {
    // Reads/metadata failures and acknowledged partial-batch continuations are
    // retryable. Unknown destructive outcomes retain their claim indefinitely.
    if (worker && !destructivePending) {
      try { await worker.admin.rpc("release_identity_deletion_worker", { p_owner_id: worker.userId, p_claim_token: worker.token }); } catch { /* A lost release response never grants a second worker. */ }
    }
  }
});
