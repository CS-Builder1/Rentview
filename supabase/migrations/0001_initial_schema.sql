-- RentView — Initial schema
-- Operations / maintenance-first property management for mixed residential + retail portfolios.
--
-- Design notes:
--   * Single owner-operator model. Every row is scoped by owner_id = auth.uid() and isolated via RLS.
--   * Hierarchy: property -> unit. Units are FIRST-CLASS and fully independent, so one property
--     (a "complex") can hold many apartments/spaces that each differ (type, size, rent, tenant).
--     A single home or single store is simply a property with one unit.
--   * Assets, work orders, expenses, parts, documents and tasks can attach at the PROPERTY level
--     (shared roof, common HVAC, the building) OR the UNIT level (what's in Apt 2B), via a
--     nullable unit_id alongside a required property_id.
--   * Internationally neutral: currency stored per-property and per-amount; no US-specific
--     screening / lease-generation / tax logic.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";       -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type property_type   as enum ('residential', 'commercial', 'mixed');
create type unit_type        as enum ('apartment', 'house', 'retail', 'office', 'storage', 'whole_property', 'other');
create type unit_status      as enum ('occupied', 'vacant', 'maintenance', 'unavailable');
create type lease_status     as enum ('active', 'pending', 'expired', 'terminated');
create type asset_status     as enum ('operational', 'needs_attention', 'out_of_service', 'retired');
create type wo_priority      as enum ('low', 'medium', 'high', 'urgent');
create type wo_status        as enum ('open', 'in_progress', 'on_hold', 'completed', 'cancelled');
create type expense_category as enum ('repair', 'capex', 'utility', 'supplies', 'service', 'insurance', 'tax', 'other');
create type task_status      as enum ('pending', 'in_progress', 'completed', 'cancelled');
create type schedule_freq    as enum ('daily', 'weekly', 'monthly', 'quarterly', 'biannual', 'annual', 'custom');
create type doc_type         as enum ('lease', 'warranty', 'receipt', 'manual', 'invoice', 'insurance', 'photo', 'other');
create type sub_provider     as enum ('lemonsqueezy', 'paypal');
create type sub_status       as enum ('trialing', 'active', 'past_due', 'cancelled', 'expired');
create type plan_tier        as enum ('free', 'pro');

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  full_name     text,
  base_currency text not null default 'USD',     -- ISO 4217; owner's default display currency
  locale        text not null default 'en',
  country       text,                            -- ISO 3166-1 alpha-2 (e.g. 'LC' Saint Lucia)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile row when a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- properties (the building / complex / location)
-- ---------------------------------------------------------------------------
create table public.properties (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  property_type property_type not null default 'residential',
  address_line1 text,
  address_line2 text,
  city          text,
  region        text,                           -- state / parish / province
  postal_code   text,
  country       text,                           -- ISO 3166-1 alpha-2
  currency      text not null default 'USD',    -- base currency for this property's finances
  estimated_value   numeric(14,2),              -- for value-retention analytics
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_properties_owner on public.properties(owner_id);

create trigger trg_properties_updated_at
  before update on public.properties
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- units (apartments / retail spaces / etc. — independent within a property)
-- ---------------------------------------------------------------------------
create table public.units (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  property_id   uuid not null references public.properties(id) on delete cascade,
  label         text not null,                  -- e.g. "Apt 2B", "Storefront", "Main House"
  unit_type     unit_type not null default 'apartment',
  status        unit_status not null default 'vacant',
  bedrooms      smallint,
  bathrooms     numeric(3,1),
  floor         text,
  size_value    numeric(10,2),                  -- area
  size_unit     text default 'sqft',            -- 'sqft' | 'sqm' (international)
  rent_amount   numeric(12,2),
  rent_currency text,                           -- defaults to property currency in app layer
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_units_owner on public.units(owner_id);
create index idx_units_property on public.units(property_id);

create trigger trg_units_updated_at
  before update on public.units
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- leases (lightweight tenant tracking — NOT screening / lease generation)
-- ---------------------------------------------------------------------------
create table public.leases (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  unit_id        uuid not null references public.units(id) on delete cascade,
  tenant_name    text not null,
  tenant_email   text,
  tenant_phone   text,
  start_date     date,
  end_date       date,
  rent_amount    numeric(12,2),
  rent_currency  text,
  deposit_amount numeric(12,2),
  status         lease_status not null default 'active',
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index idx_leases_owner on public.leases(owner_id);
create index idx_leases_unit on public.leases(unit_id);

create trigger trg_leases_updated_at
  before update on public.leases
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- vendors / technicians / contractors
-- ---------------------------------------------------------------------------
create table public.vendors (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  trade      text,                              -- e.g. "Plumber", "Electrician", "HVAC"
  phone      text,
  email      text,
  company    text,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_vendors_owner on public.vendors(owner_id);

create trigger trg_vendors_updated_at
  before update on public.vendors
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- assets / fixtures (lifecycle tracking) — property-level or unit-level
-- ---------------------------------------------------------------------------
create table public.assets (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users(id) on delete cascade,
  property_id       uuid not null references public.properties(id) on delete cascade,
  unit_id           uuid references public.units(id) on delete set null,  -- null = shared/common
  name              text not null,
  category          text,                       -- e.g. "Appliance", "HVAC", "Plumbing fixture"
  make              text,
  model             text,
  serial_number     text,
  install_date      date,
  warranty_expiry   date,
  expected_life_years smallint,                 -- for replacement forecasting
  purchase_cost     numeric(12,2),
  purchase_currency text,
  status            asset_status not null default 'operational',
  qr_code           text unique,                -- scannable tag id
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index idx_assets_owner on public.assets(owner_id);
create index idx_assets_property on public.assets(property_id);
create index idx_assets_unit on public.assets(unit_id);

create trigger trg_assets_updated_at
  before update on public.assets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- work orders (maintenance) — property-level or unit-level, optional asset
-- ---------------------------------------------------------------------------
create table public.work_orders (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  property_id   uuid not null references public.properties(id) on delete cascade,
  unit_id       uuid references public.units(id) on delete set null,
  asset_id      uuid references public.assets(id) on delete set null,
  vendor_id     uuid references public.vendors(id) on delete set null,
  title         text not null,
  description   text,
  priority      wo_priority not null default 'medium',
  status        wo_status not null default 'open',
  due_date      date,
  completed_at  timestamptz,
  cost          numeric(12,2),
  cost_currency text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_work_orders_owner on public.work_orders(owner_id);
create index idx_work_orders_property on public.work_orders(property_id);
create index idx_work_orders_unit on public.work_orders(unit_id);
create index idx_work_orders_status on public.work_orders(status);

create trigger trg_work_orders_updated_at
  before update on public.work_orders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- inventory items (supplies / parts on hand) — optional location scoping
-- ---------------------------------------------------------------------------
create table public.inventory_items (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users(id) on delete cascade,
  property_id     uuid references public.properties(id) on delete cascade,  -- null = global stock
  unit_id         uuid references public.units(id) on delete set null,
  name            text not null,
  sku             text,
  quantity        numeric(12,2) not null default 0,
  unit_label      text default 'unit',          -- e.g. "each", "box", "litre"
  unit_cost       numeric(12,2),
  cost_currency   text,
  low_stock_threshold numeric(12,2),
  location        text,                          -- where it's stored
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_inventory_owner on public.inventory_items(owner_id);
create index idx_inventory_property on public.inventory_items(property_id);

create trigger trg_inventory_updated_at
  before update on public.inventory_items
  for each row execute function public.set_updated_at();

-- parts consumed on a work order (links inventory usage to a job + property)
create table public.work_order_parts (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users(id) on delete cascade,
  work_order_id     uuid not null references public.work_orders(id) on delete cascade,
  inventory_item_id uuid references public.inventory_items(id) on delete set null,
  description       text,                        -- free-text if not from inventory
  quantity          numeric(12,2) not null default 1,
  unit_cost         numeric(12,2),
  cost_currency     text,
  created_at        timestamptz not null default now()
);

create index idx_wop_owner on public.work_order_parts(owner_id);
create index idx_wop_work_order on public.work_order_parts(work_order_id);

-- ---------------------------------------------------------------------------
-- expenses / bills — property-level or unit-level, optionally tied to a job
-- ---------------------------------------------------------------------------
create table public.expenses (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  property_id   uuid references public.properties(id) on delete cascade,
  unit_id       uuid references public.units(id) on delete set null,
  work_order_id uuid references public.work_orders(id) on delete set null,
  vendor_id     uuid references public.vendors(id) on delete set null,
  category      expense_category not null default 'other',
  description   text,
  amount        numeric(12,2) not null,
  currency      text not null default 'USD',
  incurred_on   date not null default current_date,
  is_recurring  boolean not null default false,
  recurrence    schedule_freq,
  receipt_url   text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_expenses_owner on public.expenses(owner_id);
create index idx_expenses_property on public.expenses(property_id);
create index idx_expenses_incurred on public.expenses(incurred_on);

create trigger trg_expenses_updated_at
  before update on public.expenses
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- tasks (reminders / recurring everyday tasks)
-- ---------------------------------------------------------------------------
create table public.tasks (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  property_id uuid references public.properties(id) on delete cascade,
  unit_id     uuid references public.units(id) on delete set null,
  title       text not null,
  description text,
  status      task_status not null default 'pending',
  due_date    date,
  is_recurring boolean not null default false,
  recurrence  schedule_freq,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_tasks_owner on public.tasks(owner_id);
create index idx_tasks_due on public.tasks(due_date);

create trigger trg_tasks_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- preventive maintenance schedules (time-based triggers)
-- ---------------------------------------------------------------------------
create table public.maintenance_schedules (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  property_id  uuid references public.properties(id) on delete cascade,
  unit_id      uuid references public.units(id) on delete set null,
  asset_id     uuid references public.assets(id) on delete set null,
  title        text not null,
  description  text,
  frequency    schedule_freq not null default 'quarterly',
  interval_days integer,                         -- used when frequency = 'custom'
  next_due     date,
  last_done    date,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index idx_sched_owner on public.maintenance_schedules(owner_id);
create index idx_sched_next_due on public.maintenance_schedules(next_due);

create trigger trg_sched_updated_at
  before update on public.maintenance_schedules
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- documents (leases, warranties, receipts, manuals) — linked to anything
-- ---------------------------------------------------------------------------
create table public.documents (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  property_id uuid references public.properties(id) on delete cascade,
  unit_id     uuid references public.units(id) on delete set null,
  asset_id    uuid references public.assets(id) on delete set null,
  work_order_id uuid references public.work_orders(id) on delete set null,
  name        text not null,
  doc_type    doc_type not null default 'other',
  storage_path text not null,                    -- path within Supabase Storage bucket
  mime_type   text,
  size_bytes  bigint,
  created_at  timestamptz not null default now()
);

create index idx_documents_owner on public.documents(owner_id);
create index idx_documents_property on public.documents(property_id);

-- ---------------------------------------------------------------------------
-- subscriptions / billing (Lemon Squeezy + PayPal)
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references auth.users(id) on delete cascade,
  provider            sub_provider not null,
  provider_subscription_id text,                 -- external id from LS / PayPal
  provider_customer_id     text,
  plan                plan_tier not null default 'free',
  status              sub_status not null default 'active',
  current_period_end  timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index uniq_subscriptions_owner on public.subscriptions(owner_id);
create index idx_subscriptions_provider_sub on public.subscriptions(provider, provider_subscription_id);

create trigger trg_subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security: every owner sees only their own rows.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  owned_tables text[] := array[
    'properties','units','leases','vendors','assets','work_orders',
    'inventory_items','work_order_parts','expenses','tasks',
    'maintenance_schedules','documents','subscriptions'
  ];
begin
  foreach t in array owned_tables loop
    execute format('alter table public.%I enable row level security;', t);
    execute format($f$
      create policy "owner_select_%1$s" on public.%1$I
        for select using (owner_id = auth.uid());
    $f$, t);
    execute format($f$
      create policy "owner_insert_%1$s" on public.%1$I
        for insert with check (owner_id = auth.uid());
    $f$, t);
    execute format($f$
      create policy "owner_update_%1$s" on public.%1$I
        for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
    $f$, t);
    execute format($f$
      create policy "owner_delete_%1$s" on public.%1$I
        for delete using (owner_id = auth.uid());
    $f$, t);
  end loop;
end;
$$;

-- profiles: self-access only
alter table public.profiles enable row level security;

create policy "profiles_select_self" on public.profiles
  for select using (id = auth.uid());
create policy "profiles_update_self" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
create policy "profiles_insert_self" on public.profiles
  for insert with check (id = auth.uid());
