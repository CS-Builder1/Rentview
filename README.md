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
  (app)/                 Authenticated tabs
    index.tsx            Portfolio overview
    properties.tsx       Properties list + add
    property/[id].tsx    Property detail + units (varying complexes)
    work-orders.tsx      Work orders list + add
    more.tsx             Plan/billing, sign out, in-app account deletion
components/ui.tsx        Shared UI primitives
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

**Tenant portal — schema only.** `0004_tenant_portal.sql` ships the full backend
(tenant role, invite codes + claim RPC, `tenant_lease_details`, maintenance requests
with photos and messaging, rent payment history, announcements, and the work-order →
request status mirror). The tenant-facing screens and the owner-side invite/triage UI
are not built yet.

**Next:** tenant portal UI, push notifications (`expo-notifications`), and wiring the
Lemon Squeezy + PayPal checkout.
