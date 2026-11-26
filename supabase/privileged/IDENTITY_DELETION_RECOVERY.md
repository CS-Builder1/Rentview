# Deletion worker recovery

`delete-account` claims one private, service-only token per identity before it
lists or removes any Storage names. A concurrent caller receives HTTP 409 with
`deletion_in_progress` or `deletion_review_required`. Confirmed provider
rejections return HTTP 503 with `deletion_retryable` after the worker
acknowledges the step and releases its claim. The account screen permits
continuation. A retry lists current ownership and rechecks billing. Normal
acknowledged partial cleanup returns HTTP 202 and releases the claim for
continuation. The deletion-request tombstone continues to freeze account writes.

On an authenticated retry, a running worker idle for ten minutes between
destructive steps can be replaced atomically. Listing and cleanup metadata
operations renew that interval. A replaced worker's token cannot start another
Storage or Auth operation. A worker with a pending destructive call or a
`needs_review` claim remains exclusive indefinitely. A Storage remove addresses
a name, so an earlier request could delete another participant's replacement at
the same path. A timeout, cancellation or a missing response cannot establish
that the request has finished.

Before rollout, separately authorize the hosted target, quiesce old deletion
handlers, and establish that their destructive requests have finished. Apply the
claim migration and deploy its matching handler together. Old unclaimed cleanup
RPC signatures intentionally lose service-role execution permission, so an old
handler fails closed instead of bypassing serialization. This repository has not
performed that hosted rollout or established provider cancellation semantics.

## When an owner reports a blocked deletion

This is an operator action requiring explicit authority for the actual target.
There is no customer endpoint to override a claim.

1. Inspect only the selected identity's row in
   `rentview_private.identity_deletion_workers`: `owner_id`, `state`,
   `destructive_pending`, `claimed_at`, and `updated_at`. Keep the claim token
   private; never ask the customer to provide or publish it. A running row with `destructive_pending = false` is eligible for authenticated
   retry after ten minutes of inactivity. Investigate a running row with pending
   work using the same process as a row marked `needs_review`.
2. Prove that the exact old worker has terminated and **every destructive
   Storage/Auth request it dispatched has a terminal server-side outcome**.
   Correlate provider request IDs and service logs. If this cannot be established,
   leave the claim blocked and escalate to the provider/operator. Elapsed time
   alone is insufficient.
3. Reconcile the current Auth identity and Storage inventory using authorized
   provider APIs and the current object ownership. Inspect cleanup provenance
   under `rentview_private.identity_storage_cleanup`. Distinguish an absent old
   object from a foreign replacement at the same bucket/name. Do not remove a
   replacement, replay an old name list, or alter Storage catalog rows directly.
   Successful Auth deletion normally cascades the claim; an absent Auth identity
   with a remaining claim is an inconsistency to investigate, not a retry target.
4. With the old work proven terminal, release **only the exact reviewed claim**
   in a short privileged transaction. Lock its row, compare the privately
   reviewed `claim_token` and `updated_at`, then delete that row with both values
   and the selected owner in the predicate. Require exactly one affected row;
   otherwise roll back and re-inspect. A generic delete by owner or age can
   release a newer worker and is unsafe. Record the operator, evidence, selected
   owner, and outcome without logging the token.
5. Leave `public.account_deletion_requests` and cleanup provenance intact. The
   customer's authenticated continuation claims a fresh token, re-lists current
   ownership, reconciles confirmed missing-object metadata, rechecks billing,
   and performs the remaining work. A successful normal continuation releases
   its claim or cascades it through Auth deletion.

The handler recognizes GoTrue’s returned database refusal, including the HTTP
500 caused by the billing guard, and explicit Storage API rejections. Missing
responses, gateway timeouts and lost step acknowledgments retain their claims
for review.

## Validation limits

The SQL and handler fixtures verify exclusive claims, wrong-token denial,
idle token rotation, exclusion during pending work, release after a provider refusal or acknowledged continuation, concurrent invocation
rejection, retained claims after unknown outcomes, old-RPC denial, and foreign
replacement preservation. They do not prove successful deletion through a live
Edge runtime, provider delivery, or the ability to terminate an already-dispatched
hosted Storage request. Those remain release gates.
