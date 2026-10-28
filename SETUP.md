# Validation and release setup

The implementation validation gates below precede release configuration. Provider credentials and product policy decisions require your accounts or input. The new source must not be deployed against the previous schema.

**Nothing here is urgent unless the "Blocks" line says so.**

Hosted configuration has not been changed or revalidated during this local implementation.

---

## Local validation and release gates

The trust/core-workflow source is prepared for draft review. Hosted behavior
is unchanged. The CLI-generated trust migration
`20261028190215_trust_and_operations.sql` passed the original 15-stage replay
with ten genuine migration records over deliberately inconsistent legacy fixtures.
The additive `20261028193614_optimize_identity_policies.sql` then passed ten
continuation stages, recording the eleventh migration without history repair.
Exactly 68 identity predicates changed; other authorization metadata stayed
identical. Advisors now report zero errors and eight unsuppressed warnings.

After the Metro 0.84.5 security update, 107 regression tests, both type checks,
SDK compatibility, a local-key web export, 13 real core E2E checkpoints and 36
phone/desktop browser edge checks passed again. These are browser emulation and
local-backend results, not physical-device or provider-delivery proof. The
separate owner-only pg_net ACL repair passed on both disposable databases,
including wrong-owner rejection, strict browser denial, worker access and backend
regressions. Eleven API boundary checks passed again after repair; advisors stayed
at zero errors and eight warnings. Hosted owner-supported maintenance remains a
release prerequisite.
See [VALIDATION.md](./VALIDATION.md) and
[SECURITY_RELEASE_GATES.md](./SECURITY_RELEASE_GATES.md) for evidence and open gates.

The combined current application export also passes the bounded recovery,
finance and accessibility continuation: nine checks per suite, plus exact-cent
and in-flight-save probes. The final core/URL reruns pass 13/36 checks, all 108
unit/handler tests and both final type checks pass, and the source manifest
matches all 82 app/component/library files. The local mailbox exercises real
PKCE recovery, not external email delivery. Partial-deletion tests establish
recovery navigation and retry after interruption; successful Edge-runtime
account deletion remains unverified. Finance checks cover 1,007-row exports,
separate currencies, Pacific/Atlantic dates, durable failed saves and lost
responses. Accessibility checks cover selected keyboard, naming, modal, radio
and validation behavior; they do not establish full WCAG or screen-reader output.

Validation order:

1. Start an explicitly disposable Supabase-compatible PostgreSQL environment with existing migrations `0001` through `0009`. Use synthetic owner A, owner B, tenant and unrelated-user accounts only.
2. Run `tests/db/preflight.sql` before an upgrade fixture. Existing inconsistent relationships are retained; new `NOT VALID` constraints protect new writes. Reconcile legacy fixtures and validate those constraints before rollout. Never assume that adding a constraint retroactively proved old rows safe.
3. Apply the trust migration, reconcile and validate the deliberately inconsistent legacy fixture, then apply the additive identity migration in order. Each file must complete atomically. On the approved disposable target, apply `supabase/privileged/lock_down_pg_net.sql` separately as the actual extension owner; it refuses the migration role and unexpected versions/layouts. The regression command verifies effective privileges as well as application rules, so it fails until that owner-supported boundary is established. Run the rollback-based regression scripts:

   ```bash
   RENTVIEW_DISPOSABLE_DATABASE=1 \
   RENTVIEW_TEST_DATABASE_URL=postgresql://postgres:local-test-password@127.0.0.1:54322/postgres \
   npm run test:db
   ```

   This rollback-suite runner refuses non-loopback hosts, URL connection overrides, and missing disposable opt-in. It does not create/apply schemas or fall back to a hosted connection. The separate Docker initializer in `tests/db/validate-local.py` now includes both migrations, legacy validation and RLS performance checks in its 20-stage plan. Its seven source-only guard tests pass; that revised initializer has not been rerun from scratch. Resume rejects stale migration/input hashes and stage plans before database construction.
4. Validate competing transactions: Free capacity, double invite claim, request conversion, stock use, repeated job completion, out-of-order billing, and account deletion versus billing. The sequential SQL fixtures do not establish concurrent behavior by themselves.
5. Run `tests/e2e/local_e2e.py` with explicit disposable opt-in, a loopback app URL and owner-only local credentials. The 13-checkpoint core journey passes on the combined changes, including owner setup, invitation/signup, photos/messages, conversion/vendor/stock/cost, tenant rating/reopening, browser offline recovery, hostile API writes, concurrent limits and revocation. Separate local recovery/account, finance/export/timezone and keyboard/accessibility suites now pass their bounded cases; use the exact evidence and exclusions in [VALIDATION.md](./VALIDATION.md). `tests/e2e/plan.json` records remaining broader coverage. These passes do not establish every device, provider, deletion-completion or accessibility scenario.
6. Verify web and physical iOS/Android callbacks, push deep links, disabled permissions, and queued uploads. The SDK compatibility alignment now passes with Expo 56.0.12 and Router 56.2.11; an ESLint installation/configuration remains pending. Passing TypeScript/build checks does not prove native device behavior.
7. Review both migrations, legacy/retention choices, remaining dependency advisories and provider readiness before any separately authorized hosted rollout. Scoped Metro patch pins remove the two image-size advisories; decode-uri-component, deepmerge and Zod remain open. Keep those findings visible in the release decision. No CI workflow is added by this change. Publication checks are reported on the PR; hosted deployment remains gated.

New backend configuration requirements (server secrets, never `EXPO_PUBLIC_*`):

- Lemon Squeezy requires `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_ID`, and explicit `LEMONSQUEEZY_TEST_MODE` when using test purchases.
- PayPal requires its verification credentials, `PAYPAL_PLAN_ID`, and the expected environment.
- Billing metadata supplied by a customer is not account authorization. Unknown subscriptions are recorded for reconciliation instead of granting access. **Both paid checkout buttons remain disabled** until authenticated checkout creates a trusted service-owned provider binding and handles checkout expiry/deletion. Ordinary account creation remains enabled. Legacy paid rows were formerly client-writable and require explicit reconciliation; they are not automatically trusted.
- Notifications require durable worker scheduling plus Expo credentials/shared secret; email fallback requires `RESEND_API_KEY` and verified `NOTIFICATIONS_FROM`. Reminders additionally require verified `REMINDERS_FROM`, `CRON_SECRET`, and a chosen `REMINDERS_TIMEZONE`/`REMINDERS_LOCAL_HOUR`. Function deployment alone proves none of these credentials work.
- Production Auth redirect allowlists must include the production `/callback` URL and native `rentview://callback`, with the permitted continuation query parameters. The checked-in config supplies local defaults only; it has not updated hosted settings.
- Email changes are deferred until a verified PKCE/confirmation flow is implemented and tested. Ordinary account signup, Google sign-in, password recovery and profile-name editing remain available.
- Native QR/invite sharing requires a configured HTTPS `EXPO_PUBLIC_APP_URL`; it no longer falls back to an unrelated preview address.

Product decisions retained for review: Free still means three properties; no new pricing axis was invented. `past_due` entitlement retains the existing grace behavior pending a defined billing policy. Unlinking a tenant revokes new request/message/photo access, while existing signed URLs can remain valid until expiry (new links use a short lifetime). Tenant identity deletion preserves owner repair history with nullable participant IDs; owner/property deletion keeps existing cascade behavior. Confirm the required retention/anonymization and financial correction policies before a hosted rollout.

## 1. Supabase Auth — leaked password protection

- [ ] Supabase dashboard → Authentication → Policies → enable **leaked password
      protection** (checks new passwords against HaveIBeenPwned).

Run the hosted security advisor again before release; earlier advisor results do not validate the pending schema.
**Effort:** one toggle.

---

## 2. Push notifications — Expo project + credentials

The local source includes durable push handling. Delivery requires validated database triggers, worker scheduling, and Expo credentials.

- [ ] `eas init` — writes `extra.eas.projectId` into `app.json`. Commit that
      change.
- [ ] `eas build --profile development` — Expo Go cannot receive remote push
      from SDK 53 onward, so testing needs a development build.
- [ ] `eas credentials` — FCM (Android) and APNs (iOS) keys. EAS manages them.

**Blocks:** all push delivery. Without a project id the app logs a warning,
skips registration and otherwise runs normally.
**Effort:** 20–30 minutes, mostly waiting on a build.

---

## 3. Push notifications — the hook secret

The triggers call the `send-push` function with a shared secret. Validate the hook URL and secret together during an authorized release; neither value has been changed here. Generate secrets without putting them in a transcript or commit.

- [ ] Generate one: `openssl rand -hex 32`
- [ ] Give it to the function:
      `supabase secrets set PUSH_HOOK_SECRET=<value>`
- [ ] Give the same value to the database — Supabase SQL editor:
      ```sql
      select vault.create_secret('<value>', 'push_hook_secret');
      ```
- [ ] Check both halves are set:
      ```sql
      select hook_url is not null as url, hook_secret is not null as secret
      from public.push_hook_config();
      ```

**Blocks:** all push delivery. Until it is set, `notify_push()` returns
immediately — writes still succeed, nobody is notified.
**Effort:** 5 minutes. To rotate later, set a new secret in both places.

---

## 4. Billing — Lemon Squeezy (the primary path)

- [ ] Create the store, product and a subscription variant (~$19/mo).
- [ ] Implement and validate authenticated checkout that stores a trusted provider-to-account binding on the server. A public checkout URL or customer-supplied account id cannot establish ownership.
- [ ] Create a webhook pointing at
      `https://blxkpwokmduxkfwlzexh.supabase.co/functions/v1/lemonsqueezy-webhook`,
      subscribed to the `subscription_*` events, with a signing secret.
- [ ] `supabase secrets set LEMONSQUEEZY_WEBHOOK_SECRET=<the signing secret>`
- [ ] With separate authorization, test provider sandbox checkout, trusted binding, webhook retries, cancellation and reconciliation. Verify the service-owned subscription state and resulting entitlement.

**Blocks:** paid checkout. The button stays disabled until the trusted initial binding lifecycle is implemented and validated; setting a public URL alone does not enable it.
**Effort:** ~30 minutes including a test purchase.

---

## 5. Billing — PayPal (the secondary path)

- [ ] Create a product and billing plan, then integrate authenticated server-side subscription creation and a trusted account binding.
- [ ] Create a webhook pointing at
      `https://blxkpwokmduxkfwlzexh.supabase.co/functions/v1/paypal-webhook`,
      subscribed to the `BILLING.SUBSCRIPTION.*` events.
- [ ] Set the credentials the function verifies deliveries with:
      ```bash
      supabase secrets set PAYPAL_CLIENT_ID=... PAYPAL_SECRET=... \
        PAYPAL_WEBHOOK_ID=... PAYPAL_ENV=live
      ```
      (`PAYPAL_ENV=sandbox` while testing.)

**Blocks:** PayPal checkout. Payer email and `custom_id` do not authorize an account binding. Unmatched signed events remain recorded and retryable for controlled reconciliation; no customer-facing reconciliation interface is implemented yet.
**Effort:** ~45 minutes; PayPal's console is slower than Lemon Squeezy's.

---

## 6. Email reminders — Resend key

The local reminder source requires a validated schedule, sender and provider key before delivery can be tested.

- [ ] `supabase secrets set RESEND_API_KEY=...`
- [ ] Set `REMINDERS_FROM="RentView <you@yourdomain>"` to a verified sender.
- [ ] Optional: `CRON_SECRET=...` if you want the scheduled run, wired up per
      `supabase/reminders_cron.sql`.

**Blocks:** warranty and maintenance reminder emails.
**Effort:** 10 minutes.

---

## 7. `EXPO_PUBLIC_APP_URL`

- [ ] Set it in `.env` to your production web URL.

**Blocks:** printed asset QR codes deep-link to the right place. Everything
else ignores it.

---

## 8. A decision, not a task: what Free actually includes

The existing Free policy allows **3 properties** and everything else is unlimited —
units, work orders, assets, inventory, documents, offline capture, the tenant
portal. The implementation retains this policy pending your pricing decision.

The limit is displayed through `FREE_PROPERTY_LIMIT` in `lib/plan.ts` and enforced by the versioned database guard, applied locally only. Change both together and rerun concurrent-capacity tests if the policy changes.

- [ ] Confirm 3, or tell me a different number / a different axis entirely
      (units instead of properties, tenant-portal seats, and so on).

**Blocks:** nothing technically, but it is what someone is paying $19/mo to
lift, so it is worth deciding before you charge anyone.

---

## 9. Verify pg_net privileges and API isolation

Keep `net` outside the Data API's exposed schemas. Browser roles must also lack
effective SQL schema usage and HTTP-function execution. These are separate
boundaries; passing a REST routing check does not prove the SQL grants are safe.

The initial disposable Supabase layout granted those privileges through
`supabase_admin`, so migration-role REVOKEs did not establish the intended ACL.
`supabase/privileged/lock_down_pg_net.sql` now performs guarded owner-issued
revocation and verifies browser denial plus trusted-worker access. It is
standalone privileged maintenance, not an automatic migration. It passed on both
approved local databases, together with backend regressions and a worker enqueue
rolled back before any dispatch. The original failed assertion remains recorded.

- [ ] Arrange separately authorized extension-owner/platform support for the
      release target; do not treat a postgres-issued REVOKE as proof of success.
- [ ] Run strict effective-privilege checks and backend regressions, then verify
      Data API schema selection and privileged RPC denials on that authorized target.
- [ ] Retain `net` outside exposed schemas and recheck grants after extension or
      platform updates.

pg_net 0.20.4 is nonrelocatable. Its installation namespace remains `public` while
its member objects reside in `net`, so the namespace warning is retained. Do not
edit extension catalogs or drop/reinstall it just to clear the warning. See
[SECURITY_RELEASE_GATES.md](./SECURITY_RELEASE_GATES.md).

---

## 10. End-to-end test with two real accounts

Not credentials — just something no amount of typechecking substitutes for.

- [ ] Owner account: create a property, a unit, a lease, generate an invite.
- [ ] Tenant account (a second email): claim the code, submit a request with a
      photo, message the owner.
- [ ] Owner: convert it to a work order, complete it, confirm the tenant sees
      "resolved" and can rate it.

**Blocks:** confidence. The portal has been verified by typecheck and a clean
web build, never by two humans using it.
