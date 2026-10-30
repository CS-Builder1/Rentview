# Billing reconciliation before release

This source change does not establish whether any real legacy customer paid.
The hosted database and payment providers have not been inspected or changed.
Keep checkout disabled and keep rollout blocked until an authorized operator has
completed the following review against a protected production-data copy first.

## Legacy rollout gate

The trust migration now aborts **before changing the schema or entitlements** if
any existing subscription claims Pro or contains a provider subscription ID and
has no exact, independently reviewed decision. It never promotes the previously
client-writable row, customer email, `custom_id`, or checkout metadata to proof.

1. Enter an approved maintenance window and stop application/provider writers.
   Take the normal protected backup. Work against an isolated copy first. Do not
   run synthetic test fixtures against a hosted/shared database.
2. Run `supabase/privileged/prepare_legacy_billing_reconciliation.sql` as the
   database operator. It creates an empty private evidence ledger with no browser
   or service-role privileges. It does not grant any subscription.
3. For every legacy Pro/provider-linked row, independently retrieve the current
   subscription from the configured provider/product/environment and establish
   its original account association from a server-controlled transaction record
   or equivalent independently verified account proof. A provider record alone
   does not prove which RentView account owns it. If that second fact is absent,
   **stop for owner review**; do not infer it from matching emails or client IDs.
4. Insert an operator-reviewed ledger row containing the exact `to_jsonb(s)`
   legacy subscription snapshot, a `verified` or `rejected` decision, and separate
   protected audit references for provider and account evidence. For `verified`,
   supply the independently retrieved provider, subscription/customer IDs,
   current plan/status, paid-through time, cancellation flag and provider update
   time. For `rejected`, retain the reason and evidence references in the ledger;
   do not call an unresolved customer a forged claim. Keep credentials, payment
   instruments, raw provider responses and personal data out of those references.
5. Apply the trust migration atomically and then all additive migrations. Its
   gate rejects missing decisions, changed source rows, or a browser-writable
   ledger. Verified decisions populate the service-owned subscription binding
   and preserve the provider's current entitlement. Explicitly rejected claims
   become Free; the old values remain in the private audit snapshot. There is no
   automatic rejection or grace-period policy.
6. Verify account-by-account counts and current entitlement, renewal/cancellation
   delivery, and deletion holds on the isolated copy. Re-enable application
   traffic only after the authorized real rollout has the same evidence and
   validation. No live migration is authorized by this runbook.

The local legacy fixture includes one deliberately forged claim and one verified
synthetic payer with a different independently verified provider ID. It proves
the gate and source behavior; it does not prove real customer provenance.

## Unmatched and equally timed events

Authentic webhook events for a different configured product/environment return a
successful ignored response without touching billing. Malformed or unauthentic
events still fail. Unknown subscription bindings remain `unmatched` and grant no
access. The provider receives an accepted response; an operator must reconcile
these ledger rows rather than relying on automatic webhook redelivery.

Distinct states at the same provider timestamp have no reliable ordering. They
are retained as `pending` with `processing_error`, and the webhook returns
`ambiguous` (HTTP 202). The prior verified entitlement stays in place, the owner
can see a pending-review flag, and account deletion is held. Neither arrival
order nor an invented ranking of active/cancelled states decides the result.

An authorized service operator can call
`reconcile_verified_billing_subscription` with an independently retrieved current
provider snapshot and independently verified original account association. This
maintenance RPC is denied to anonymous/browser roles, cannot change an existing
binding's owner, refuses missing identities and stale snapshots, writes a private
audit record, updates the entitlement atomically and marks covered
pending/unmatched events `superseded`. While deletion is pending, reconciliation
is allowed only for an **existing binding owned by that same account**. This lets
an independently verified current cancelled snapshot resolve a late conflict and
permit deletion continuation once all other billing guards pass. Establishing a
new binding after deletion preparation is refused. The RPC mirrors provider
state; cancellation must already be confirmed by the provider. A later distinct equally timed event can
require another current snapshot. The RPC itself does not fetch provider data;
supplying evidence is an operator responsibility. Calls must never accept
customer-supplied evidence strings as authorization.

Monitor service-only `billing_events` rows in `pending`/`unmatched`, and preserve
their provider/subscription identifiers and error state in protected operational
review. The customer boolean exposes no provider identifiers, payloads, or audit
references. New authenticated checkout creation, automated provider-state
reconciliation and real provider delivery remain release gates.
