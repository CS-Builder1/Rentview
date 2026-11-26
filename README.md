# RentView

**Operations- and maintenance-first property management for mixed residential + retail portfolios.**

RentView is a cross-platform (web + iOS + Android) app for small owner-operators who
manage a *mix* of property types — apartments, single homes, and retail/commercial
spaces — and care about **protecting asset value**: tracking maintenance, per-unit
inventory, parts/supplies, asset lifecycle, vendors, and cost-per-property. It is
deliberately **internationally neutral** (multi-currency, no US-specific tenant
screening, lease generation, or tax filing).

## Why RentView

Existing tools optimize for US rent collection, screening, and Schedule E tax.
Maintenance is an afterthought and mixed residential+retail portfolios are unsupported.
RentView's wedge is the intersection of **mixed portfolio + operations-first +
internationally friendly**.

## Handling varying complexes

The data model treats **units as first-class and fully independent**:

- A **property** is a building / complex / location.
- A property has **0..N units**, each with its own type (apartment, retail, office,
  storage, house, …), status, size, rent, and tenant. So one complex can hold many
  apartments that each differ.
- A single home or single store is simply a property with **one unit**.
- Assets, work orders, expenses, parts, documents, and tasks attach at the **property
  level** (shared roof, common HVAC) *or* the **unit level** (what's in Apt 2B).

## Tech stack

| Layer              | Choice                                                            |
| ------------------ | ----------------------------------------------------------------- |
| App (one codebase) | **Expo (React Native) + Expo Router** → web, iOS, Android         |
| Styling            | **NativeWind** (Tailwind for React Native)                        |
| Backend / DB       | **Supabase** (Postgres) — system of record, with **RLS** per owner |
| Auth               | Supabase Auth (email/password)                                    |
| Storage            | Supabase Storage (photos, receipts, documents)                    |
| Billing (web)      | **Lemon Squeezy** (merchant-of-record) **and PayPal**             |

Pricing: a generous **Free** tier + a single **Pro** tier (~$19/mo), billed on the web
(app-to-web checkout) to avoid most app-store commission.

## Project layout

```
app/                     Expo Router routes
  (auth)/login.tsx       Sign in / sign up
  claim.tsx              Tenant invite-code claim (either role)
  (app)/                 Owner app
    (tabs)/index.tsx     Portfolio overview
    (tabs)/properties.tsx  Properties list + add
    property/[id].tsx    Property detail + units (varying complexes)
    unit/[id].tsx        Unit detail + leases
    lease/[id].tsx       Tenant invites + rent payment history
    (tabs)/work-orders.tsx Work orders list + add
    requests.tsx         Tenant request inbox
    request/[id].tsx     Triage: status, thread, convert to work order
    announcements.tsx    Broadcasts to tenants
    (tabs)/more.tsx      Plan/billing, sign out, in-app account deletion
  tenant/                Tenant portal (role-gated)
    (tabs)/index.tsx     My lease + notices
    (tabs)/requests.tsx  My requests
    (tabs)/rent.tsx      Rent history
    new-request.tsx      Report a repair
    request/[id].tsx     Progress, photos, thread, rating
components/ui.tsx        Shared UI primitives
components/RequestConversation.tsx  Photos + message thread (both roles)
components/PushNotifications.tsx    Device registration + notification routing
lib/
  supabase.ts            Supabase client
  auth.tsx               Auth context/provider
  database.types.ts      Generated DB types
  format.ts              i18n-neutral currency/date helpers
  push.ts                Expo push device registration
  plan.ts                Subscription entitlement + free-tier limit
supabase/
  migrations/            SQL schema (versioned)
  functions/             Edge Functions (delete-account, send-reminders,
                         send-push, lemonsqueezy-webhook, paypal-webhook)
```

## Local implementation milestone (unreleased)

The current worktree contains access-control, offline, billing, tenant-flow and owner-workflow changes. The matching SQL is versioned in `supabase/migrations/20261028190215_trust_and_operations.sql` and `20261028193614_optimize_identity_policies.sql`, tested against disposable local Supabase/PostgreSQL. Neither has been applied to the hosted project. The separate owner-only `supabase/privileged/lock_down_pg_net.sql` also passed locally; it is not an automatic migration. Do not deploy these frontend/Edge changes against the old schema. See [VALIDATION.md](./VALIDATION.md) for passing checks and coverage limits, and [SECURITY_RELEASE_GATES.md](./SECURITY_RELEASE_GATES.md) for open advisories and release decisions.

The combined application changes pass 108 regression tests, both type checks,
13 local core E2E checkpoints and 36 browser edge checks. Separate bounded suites
add nine checks each for recovery/account interruptions, finance/CSV/timezones and
keyboard/accessibility, plus exact-cent and in-flight-save probes. These fixes
preserve expense drafts and operation IDs, prevent delayed saves from erasing new
drafts, keep cross-tab auth navigation stable and expose readable keyboard
controls. Physical-device behavior, successful Edge-runtime deletion, real
provider delivery and a full accessibility audit remain release gates.

Local checks use the installed toolchain without starting CI (the dependency-free test harness requires Node 24+):

```bash
npm test
npm run typecheck
npm run typecheck:tests
```

`npm run test:db` refuses remote URLs and requires an explicitly disposable local Supabase-compatible database. Real local RLS, Storage, browser-to-database, failure and concurrency checks now supplement the unit/handler fixtures. See [SETUP.md](./SETUP.md) for validation and release gates. No hosted settings, credentials, migrations or providers have been changed.

## Getting started

```bash
npm install
cp .env.example .env      # supply the approved local publishable/anon key
npm run web               # or: npm run ios / npm run android
npm run typecheck
```

### Database

The schema lives in `supabase/migrations/`. The trust/operations and identity-optimization migrations are
local only; earlier baseline migrations do not establish that hosted schema is
current. Complete the release gates in [SETUP.md](./SETUP.md) before an authorized
hosted upgrade. The following commands are release operations, not test setup:

```bash
supabase link --project-ref <ref>
supabase db push
supabase functions deploy delete-account
supabase functions deploy send-reminders   # schedule with supabase/reminders_cron.sql
supabase functions deploy send-push
supabase functions deploy lemonsqueezy-webhook
supabase functions deploy paypal-webhook
```

Anything that needs your own accounts or credentials — Expo, Lemon Squeezy,
PayPal, Resend — is tracked in **[SETUP.md](./SETUP.md)**. The app runs with
all of it unset; each feature fails soft.

## Tenant portal

One codebase, two roles. `profiles.role` decides which app renders — existing accounts
stay `owner`, and only claiming an invite flips an account to `tenant`.

1. **Invite** — the owner opens a lease (Unit → lease card → *Invite to portal*) and
   generates a single-use code that expires in 14 days.
2. **Claim** — the tenant creates a normal account and enters the code under *Join with
   an invite code*. `claim_tenant_invite` validates it, links the lease, and flips the
   role. An account that owns properties is never demoted.
3. **Report** — the tenant submits a request against their own **active** lease. Every
   scoping column is re-validated in the database, so nothing can be forged.
4. **Triage** — the request lands in the owner's inbox. Converting it opens a work order
   and links the two; a trigger mirrors the work order's status back to the request, so
   the tenant sees progress without ever seeing costs, vendors, parts or notes.
5. **Close the loop** — the tenant rates the fix once it is resolved.

Rent payments are records the owner logs, visible to that lease's tenant. RentView does
not process payments.

## Billing

A generous **Free** tier and a single **Pro** tier, billed on the web so most app-store
commission is avoided. Lemon Squeezy is the merchant of record (it handles VAT and
receipts); PayPal is offered alongside it because parts of the world reach for PayPal
first.

**How an account becomes Pro.** A verified webhook updates access only for an
independently registered, service-owned provider subscription binding. Customer
checkout metadata, `custom_id` and payer email do not prove account ownership.
Both paid checkout controls remain disabled until authenticated server-side
subscription creation and provider reconciliation are implemented and validated.

- `lemonsqueezy-webhook` — HMAC-SHA256 over the raw body against `X-Signature`,
  compared in constant time.
- `paypal-webhook` — PayPal's verify-webhook-signature API vouches for each
  delivery; only the existing service-owned binding determines its account.

The event ledger and entitlement update commit atomically. Unbound events remain
unmatched; conflicting states at the same provider timestamp stay pending review
and hold account deletion. Authentic events for other products are acknowledged
and ignored. See [BILLING_RECONCILIATION.md](./BILLING_RECONCILIATION.md) for the
operator-only legacy rollout gate and audited current-snapshot reconciliation.

**Entitlement** (`lib/plan.ts`) is computed, not stored as a boolean. A subscription
grants Pro while `active`, `trialing` or `past_due`, and a *cancelled* one keeps it
until `current_period_end` — cutting access the moment someone cancels would be taking
money for nothing. It is read through the same cache as everything else, so being
offline never silently downgrades an account.

**What Free costs you:** `FREE_PROPERTY_LIMIT` in `lib/plan.ts` — currently 3
properties, everything else unlimited. That number is a placeholder pending a decision
(see [SETUP.md](./SETUP.md)); it is the only line separating the tiers.

## Push notifications

Notifications are what make the portal work in practice — a request nobody sees is a
phone call anyway. Delivery runs through Expo's push service.

**How a notification happens.** The DATABASE fires them, not the app. Triggers on
`maintenance_requests`, `request_messages` and `announcements` queue a call to the
`send-push` Edge Function through `pg_net`, inside the transaction that writes the row.
So a notification cannot be skipped by a client that died mid-action, and cannot fire
for a write that rolled back. The trigger passes only the event, the row id and the
actor; `send-push` loads the row with the service role and derives the recipient as the
other participant, so nobody is notified about their own action and no device token is
ever exposed.

Delivery is authenticated by a shared secret (`x-push-secret`), held in Supabase Vault
for the trigger and as a function secret for the endpoint. Neither is in this repo —
see [SETUP.md](./SETUP.md). When either half is missing, `notify_push()` returns
immediately and the app runs with notifications off.

**Muting.** `notification_prefs` carries a master switch plus one per category
(requests, messages, announcements). A missing row means everything is on, so nobody
needs back-filling. `send-push` drops muted recipients before it builds a message, and
both More tabs expose the switches.

| Event | Who gets it | Where it opens |
| ----- | ----------- | -------------- |
| Tenant files a request | Owner | `/request/[id]` |
| Status change or work order raised | Tenant | `/tenant/request/[id]` |
| Message on a request | The other participant | that request |
| Tenant closes a request | Owner | `/request/[id]` |
| Announcement posted | Tenants on active leases it targets | `/tenant` |

**Setup (one-time, and it will not work without this):**

1. `eas init` — writes `extra.eas.projectId` into `app.json`. Expo issues push tokens
   against that id; without it the app runs normally but skips registration and logs a
   warning.
2. Build a **development build** (`eas build --profile development`). Expo Go cannot
   receive remote push notifications from SDK 53 onward.
3. `eas credentials` — FCM (Android) and APNs (iOS) keys, which EAS manages for you.
4. `supabase functions deploy send-push`.

Tokens live in `push_tokens`, registered through `register_push_token` (a device can
move between accounts, so re-registering reassigns the token to the current user) and
deleted on sign-out. Expo replies `DeviceNotRegistered` for uninstalled apps; the
function drops those tokens automatically.

### Security notes

`billing_events` and worker ledgers have no client-facing policies or privileges;
trusted backend code performs their writes. That intentional access model does
not waive unrelated advisor findings.

The new tenant projection uses a `security_invoker` view over a private,
actor-scoped helper exposing only the approved lease columns. Tenants do not
receive direct base-table access to leases or invitations. The privileged claim,
membership and device-registration helpers retain explicit caller checks and
function grants; their security does not follow from a linter exception.

The initial local `pg_net` layout granted browser roles SQL access to its HTTP
helpers. A migration-role REVOKE did not remove grants issued by the extension
owner. The standalone owner-only maintenance script now passes on both disposable
databases, denying effective browser access while preserving trusted workers.
It requires the actual extension owner before changing any grants. Hosted
application and verification require separate authorization and supported owner
access; do not assume a migration's successful REVOKE established that boundary.

Keep `net` outside exposed API schemas. Eleven local API checks passed again
after repair, verifying schema and backend-RPC denials independently of the SQL
privilege tests. The nonrelocatable pg_net extension retains its public installation-namespace warning; no relocation
or catalog edit was used to suppress it. Seven intentional owner/tenant policy
performance warnings and three upstream advisory packages also remain open. See
[SECURITY_RELEASE_GATES.md](./SECURITY_RELEASE_GATES.md) for exact findings,
evidence and release prerequisites.

## Status

**Owner app — built.** Auth (email + Google), portfolio overview with alerts,
properties/units/leases, assets with QR entry, work orders with photos and parts,
vendors, inventory, expenses, preventive maintenance, document upload, offline-first
capture with a sync queue, accountant CSV export, and scheduled email reminders.

**Tenant portal — built.** Owners generate a single-use invite code on a lease; the
tenant claims it at sign-in and the app routes them to the portal instead of the owner
app. Tenants see their lease, report repairs with photos, message the owner on the
request, follow status, see the rent the owner has recorded, and rate the fix. Owners
triage requests in an inbox, convert one into a work order in a tap (costs, vendors and
parts stay private), and broadcast announcements to a property or the whole portfolio.

**Push notifications — implemented locally; device/provider delivery unverified.**
Database triggers and durable workers select recipients and honor notification
preferences. Physical-device tokens, permissions, credentials and delivery still
require the checks in [SETUP.md](./SETUP.md).

**Billing — checkout gated.** Local webhook and ledger hardening passes its fixtures.
Trusted initial provider binding, reconciliation and provider delivery must pass
before enabling paid checkout. Ordinary signup remains available. The local
source has not been deployed.

**Next:** resolve the explicit upstream, hosted, device/provider and product gates
in [SECURITY_RELEASE_GATES.md](./SECURITY_RELEASE_GATES.md). The synthetic local
owner/tenant core journey and bounded recovery, finance and keyboard suites pass;
remaining coverage limits stay explicit in [VALIDATION.md](./VALIDATION.md).
