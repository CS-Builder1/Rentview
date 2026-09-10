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
lib/
  supabase.ts            Supabase client
  auth.tsx               Auth context/provider
  database.types.ts      Generated DB types
  format.ts              i18n-neutral currency/date helpers
supabase/
  migrations/            SQL schema (versioned)
  functions/             Edge Functions (delete-account)
```

## Getting started

```bash
npm install
cp .env.example .env      # already populated with the linked project's URL + publishable key
npm run web               # or: npm run ios / npm run android
npm run typecheck
```

### Database

The schema lives in `supabase/migrations/`. It is already applied to the linked
Supabase project. To re-apply elsewhere, use the Supabase CLI:

```bash
supabase link --project-ref <ref>
supabase db push
supabase functions deploy delete-account
supabase functions deploy send-reminders   # schedule with supabase/reminders_cron.sql
```

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

### Security notes

`0004_tenant_portal.sql` intentionally uses `SECURITY DEFINER` for the tenant read
surface (`tenant_lease_details`) and for `claim_tenant_invite` / `is_tenant_of_lease` /
`tenant_lease_matches`. Tenants cannot read `leases` or `tenant_invites` directly, so
these objects *are* the boundary — each one filters on `auth.uid()` in its own
`WHERE` clause. Supabase's database linter flags them by design; that is expected, not
a finding. Enable **leaked password protection** in Auth → Policies for the linter's
remaining warning.

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

**Next:** push notifications (`expo-notifications`) and wiring the Lemon Squeezy +
PayPal checkout.
