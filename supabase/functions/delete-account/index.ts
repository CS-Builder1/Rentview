// Authenticated, retryable deletion. Cancel renewable billing first; freeze writes,
// remove only uploads owned by this identity through Storage API, then revoke its
// sessions and remove Auth. Tenant repair history is retained with nullable identity
// references by the database migration rather than cascading away an owner's work.
import { createClient } from "jsr:@supabase/supabase-js@2.109.0";
import { errorResponse, HttpError, json } from "../_shared/http.ts";

Deno.serve(async req => {
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
      if (prepareError.code === "P0001") throw new HttpError(409, "Cancel your subscription before deleting this account so billing cannot continue. You can cancel through your payment provider's receipt email.");
      throw prepareError;
    }
    const deadline = Date.now() + 70_000;
    let removed = 0;
    for (;;) {
      const { data: paths, error: pathsError } = await admin.rpc("owned_storage_paths", { p_owner_id: userId, p_limit: 100 });
      if (pathsError) throw pathsError;
      if (!paths?.length) break;
      if (Date.now() > deadline || removed >= 2000) return json({ pending: true, removed, message: "Deletion is in progress. Continue this action to finish removing your uploads." }, 202, true);
      const buckets = new Map<string, string[]>();
      for (const item of paths as { bucket_id: string; name: string }[]) buckets.set(item.bucket_id, [...(buckets.get(item.bucket_id) ?? []), item.name]);
      for (const [bucket, names] of buckets) {
        const { error } = await admin.storage.from(bucket).remove(names);
        if (error) throw error; // Never delete identity while Storage cleanup is incomplete.
        // Business attachment metadata belongs only to the attachments bucket.
        // Another private bucket can legitimately reuse the same object path.
        if (bucket === "attachments") {
          const { error: metadataError } = await admin.rpc("forget_deleted_uploads", { p_owner_id: userId, p_paths: names });
          if (metadataError) throw metadataError;
        }
        removed += names.length;
      }
    }
    // Delete Auth first so a failed final delete can be retried with the same session.
    // All writes already reject this identity; after deletion, the guard rejects its
    // still-unexpired JWT because auth.users no longer contains it.
    // Provider state can change during Storage cleanup. Recheck to give a clear
    // response; the database's Auth-delete guard closes the final transaction race.
    const { error: finalPrepareError } = await admin.rpc("prepare_identity_deletion", { p_owner_id: userId });
    if (finalPrepareError) {
      if (finalPrepareError.code === "P0001") throw new HttpError(409, "Your subscription became active during deletion. Cancel it with your payment provider, then continue deletion.");
      throw finalPrepareError;
    }
    const { error: deletionError } = await admin.auth.admin.deleteUser(userId);
    if (deletionError) throw deletionError;
    // Revocation is best-effort after successful deletion; the database guard provides
    // the strict access boundary for unexpired tokens, not merely refresh revocation.
    await admin.auth.admin.signOut(jwt, "global").catch(() => undefined);
    return json({ success: true }, 200, true);
  } catch (error) { return errorResponse(error, true); }
});
