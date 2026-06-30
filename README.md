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
```

## Status

Stage 0/1 foundation is in place: schema + RLS, auth, portfolio overview, properties &
units (varying-complex aware), and work orders. Next: assets/inventory/parts,
preventive maintenance, expenses & analytics, document upload, QR codes, offline-first
capture, and wiring the Lemon Squeezy + PayPal checkout.
