# Deletion worker recovery

`delete-account` claims one private, service-only token per identity before it
lists or removes any Storage names. A second caller receives HTTP 409 with
`deletion_in_progress` or `deletion_review_required`; it performs no cleanup.
The account screen displays the support response and disables further deletion
attempts for that screen lifetime. Reopening/reloading the screen rechecks the
server on the next authenticated attempt; the server-side claim persists across
reloads and accounts cannot override it.
Normal acknowledged partial cleanup returns HTTP 202 and releases the claim for
continuation. The deletion-request tombstone continues to freeze account writes.

The claim has **no automatic expiry or takeover**. A Storage remove addresses a
name rather than a particular immutable object version. Client timeout,
AbortSignal cancellation, an old `updated_at`, or disappearance of an Edge
invocation from a dashboard does not prove that a previously dispatched request
cannot finish later. A timed lease would permit the stale request to remove a
file subsequently created by another request participant at the same name.

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
   private; never ask the customer to provide or publish it. An old running row
   remains blocked and requires the same review as `needs_review` if its worker
   was interrupted.
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

A provider-confirmed rejected destructive request may be released after the same
proof of terminal outcome. Generic 5xx, transport errors and partial batch errors
are treated as unknown and require review. This favors preserving other
participants' files over automatically retrying uncertain name-based deletes.

## Validation limits

The SQL and handler fixtures verify exclusive claims, wrong-token denial,
non-expiry, release after acknowledged continuation, concurrent invocation
rejection, retained claims after unknown outcomes, old-RPC denial, and foreign
replacement preservation. They do not prove successful deletion through a live
Edge runtime, provider delivery, or the ability to terminate an already-dispatched
hosted Storage request. Those remain release gates.
