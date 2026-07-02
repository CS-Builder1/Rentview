-- RentView — Tenant portal
--
-- Adds a second user role ("tenant") to the single-owner model without touching
-- any existing owner policy:
--   * profiles.role ('owner' | 'tenant') — existing users stay owners.
--   * leases.tenant_user_id — links a lease to the tenant's auth account.
--   * tenant_invites — owner-generated codes a tenant claims at signup
--     (claiming happens through a SECURITY DEFINER RPC; tenants never read
--     this table directly).
--   * tenant_lease_details — SECURITY DEFINER view exposing only tenant-safe
--     columns of the tenant's own lease + unit + property.
--   * maintenance_requests — tenant-submitted repair reports, kept SEPARATE
--     from work_orders so tenants never see costs/vendors/internal notes.
--     The owner "converts" a request into a work order; a trigger mirrors
--     work-order status back onto the request.
--   * request_photos / request_messages — participant-scoped attachments and
--     a per-request message thread between tenant and owner.
--   * rent_payments — owner-recorded payment history, readable by the tenant
--     of the lease.
--   * announcements — owner broadcasts to one property or the whole portfolio.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type request_status   as enum ('submitted', 'acknowledged', 'in_progress', 'resolved', 'closed');
create type request_category as enum ('plumbing', 'electrical', 'appliance', 'hvac', 'pest', 'general', 'other');
create type payment_method   as enum ('cash', 'bank_transfer', 'check', 'mobile_money', 'other');

-- ---------------------------------------------------------------------------
-- profiles.role — existing accounts remain owners
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column role text not null default 'owner'
  check (role in ('owner', 'tenant'));

-- ---------------------------------------------------------------------------
-- leases.tenant_user_id — set when a tenant claims an invite
-- ---------------------------------------------------------------------------
alter table public.leases
  add column tenant_user_id uuid references auth.users(id) on delete set null;

create index idx_leases_tenant_user on public.leases(tenant_user_id);

-- ---------------------------------------------------------------------------
-- tenant_invites (owner-managed; tenants only touch these via the claim RPC)
-- ---------------------------------------------------------------------------
create table public.tenant_invites (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  lease_id   uuid not null references public.leases(id) on delete cascade,
  code       text not null unique check (char_length(code) >= 6),
  email      text,
  expires_at timestamptz not null default now() + interval '14 days',
  claimed_by uuid references auth.users(id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_tenant_invites_owner on public.tenant_invites(owner_id);
create index idx_tenant_invites_lease on public.tenant_invites(lease_id);

alter table public.tenant_invites enable row level security;

create policy "owner_select_tenant_invites" on public.tenant_invites
  for select using (owner_id = auth.uid());
create policy "owner_insert_tenant_invites" on public.tenant_invites
  for insert with check (owner_id = auth.uid());
create policy "owner_update_tenant_invites" on public.tenant_invites
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner_delete_tenant_invites" on public.tenant_invites
  for delete using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- claim_tenant_invite — the only path tenants take to link themselves.
-- SECURITY DEFINER: validates the code, links the lease, flips the caller's
-- role to 'tenant' (never demoting a real owner), marks the invite claimed.
-- ---------------------------------------------------------------------------
create or replace function public.claim_tenant_invite(invite_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite tenant_invites%rowtype;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_invite
  from tenant_invites
  where code = upper(trim(invite_code))
  for update;

  if not found then
    raise exception 'Invalid invite code';
  end if;
  if v_invite.claimed_at is not null then
    raise exception 'This invite has already been used';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'This invite has expired';
  end if;
  if v_invite.owner_id = v_uid then
    raise exception 'You cannot claim your own invite';
  end if;

  update leases
  set tenant_user_id = v_uid
  where id = v_invite.lease_id;

  -- Flip role to tenant, but never demote an account that owns properties.
  update profiles
  set role = 'tenant'
  where id = v_uid
    and role = 'owner'
    and not exists (select 1 from properties p where p.owner_id = v_uid);

  update tenant_invites
  set claimed_by = v_uid, claimed_at = now()
  where id = v_invite.id;

  return json_build_object('lease_id', v_invite.lease_id);
end;
$$;

revoke execute on function public.claim_tenant_invite(text) from public, anon;
grant execute on function public.claim_tenant_invite(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Helper predicates (SECURITY DEFINER so policies can consult leases, which
-- tenants cannot read directly).
-- ---------------------------------------------------------------------------
create or replace function public.is_tenant_of_lease(p_lease uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from leases l
    where l.id = p_lease and l.tenant_user_id = auth.uid()
  );
$$;

-- Validates every scoping column of a tenant-submitted maintenance request
-- against the caller's own ACTIVE lease, so no field can be forged.
create or replace function public.tenant_lease_matches(
  p_lease uuid, p_unit uuid, p_property uuid, p_owner uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from leases l
    join units u on u.id = l.unit_id
    where l.id = p_lease
      and l.tenant_user_id = auth.uid()
      and l.status = 'active'
      and l.unit_id = p_unit
      and u.property_id = p_property
      and l.owner_id = p_owner
  );
$$;

revoke execute on function public.is_tenant_of_lease(uuid) from public, anon;
grant execute on function public.is_tenant_of_lease(uuid) to authenticated;
revoke execute on function public.tenant_lease_matches(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.tenant_lease_matches(uuid, uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- tenant_lease_details — the tenant's read surface for lease/unit/property.
-- SECURITY DEFINER view (owner's rights bypass RLS); the WHERE clause is the
-- security boundary. Exposes only tenant-safe columns — no notes, no
-- estimated_value, no other units.
-- ---------------------------------------------------------------------------
create view public.tenant_lease_details
with (security_barrier = true)
as
select
  l.id as lease_id,
  l.unit_id,
  l.owner_id,
  l.start_date,
  l.end_date,
  l.rent_amount,
  l.rent_currency,
  l.deposit_amount,
  l.status,
  u.label as unit_label,
  u.unit_type,
  u.property_id,
  p.name as property_name,
  p.address_line1,
  p.city,
  p.region,
  p.country,
  pr.full_name as landlord_name
from public.leases l
join public.units u on u.id = l.unit_id
join public.properties p on p.id = u.property_id
left join public.profiles pr on pr.id = l.owner_id
where l.tenant_user_id = auth.uid();

revoke all on public.tenant_lease_details from public, anon;
grant select on public.tenant_lease_details to authenticated;

-- ---------------------------------------------------------------------------
-- maintenance_requests — tenant-submitted, owner-triaged
-- ---------------------------------------------------------------------------
create table public.maintenance_requests (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  lease_id       uuid not null references public.leases(id) on delete cascade,
  unit_id        uuid not null references public.units(id) on delete cascade,
  property_id    uuid not null references public.properties(id) on delete cascade,
  tenant_user_id uuid not null references auth.users(id) on delete cascade,
  work_order_id  uuid references public.work_orders(id) on delete set null,
  title          text not null,
  description    text,
  category       request_category not null default 'general',
  urgency        wo_priority not null default 'medium',
  status         request_status not null default 'submitted',
  rating         smallint check (rating between 1 and 5),
  rating_comment text,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- Ratings only make sense once the work is done.
  check (rating is null or status in ('resolved', 'closed'))
);

create index idx_requests_owner on public.maintenance_requests(owner_id);
create index idx_requests_tenant on public.maintenance_requests(tenant_user_id);
create index idx_requests_status on public.maintenance_requests(status);
create index idx_requests_work_order on public.maintenance_requests(work_order_id);

create trigger trg_requests_updated_at
  before update on public.maintenance_requests
  for each row execute function public.set_updated_at();

alter table public.maintenance_requests enable row level security;

-- Owner: full control over requests for their portfolio.
create policy "owner_select_requests" on public.maintenance_requests
  for select using (owner_id = auth.uid());
create policy "owner_insert_requests" on public.maintenance_requests
  for insert with check (owner_id = auth.uid());
create policy "owner_update_requests" on public.maintenance_requests
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner_delete_requests" on public.maintenance_requests
  for delete using (owner_id = auth.uid());

-- Tenant: sees own requests; may create requests only against their own
-- active lease (every scoping column validated); may update own requests
-- (close, rate — the table check keeps ratings honest).
create policy "tenant_select_requests" on public.maintenance_requests
  for select using (tenant_user_id = auth.uid());
create policy "tenant_insert_requests" on public.maintenance_requests
  for insert with check (
    tenant_user_id = auth.uid()
    and public.tenant_lease_matches(lease_id, unit_id, property_id, owner_id)
  );
create policy "tenant_update_requests" on public.maintenance_requests
  for update using (tenant_user_id = auth.uid())
  with check (tenant_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- request_photos — participant-scoped photo metadata (files live in Storage
-- under attachments/requests/<request_id>/...)
-- ---------------------------------------------------------------------------
create table public.request_photos (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.maintenance_requests(id) on delete cascade,
  storage_path text not null,
  created_at   timestamptz not null default now()
);

create index idx_request_photos_request on public.request_photos(request_id);

alter table public.request_photos enable row level security;

create policy "participants_select_request_photos" on public.request_photos
  for select using (
    exists (
      select 1 from public.maintenance_requests r
      where r.id = request_id
        and (r.owner_id = auth.uid() or r.tenant_user_id = auth.uid())
    )
  );
create policy "participants_insert_request_photos" on public.request_photos
  for insert with check (
    exists (
      select 1 from public.maintenance_requests r
      where r.id = request_id
        and (r.owner_id = auth.uid() or r.tenant_user_id = auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- request_messages — per-request thread between tenant and owner
-- ---------------------------------------------------------------------------
create table public.request_messages (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.maintenance_requests(id) on delete cascade,
  sender_id  uuid not null references auth.users(id) on delete cascade,
  body       text not null check (char_length(body) > 0),
  created_at timestamptz not null default now()
);

create index idx_request_messages_request on public.request_messages(request_id, created_at);

alter table public.request_messages enable row level security;

create policy "participants_select_request_messages" on public.request_messages
  for select using (
    exists (
      select 1 from public.maintenance_requests r
      where r.id = request_id
        and (r.owner_id = auth.uid() or r.tenant_user_id = auth.uid())
    )
  );
create policy "participants_insert_request_messages" on public.request_messages
  for insert with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.maintenance_requests r
      where r.id = request_id
        and (r.owner_id = auth.uid() or r.tenant_user_id = auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- Mirror work-order status back onto a converted request
-- ---------------------------------------------------------------------------
create or replace function public.sync_request_from_work_order()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    update maintenance_requests
    set status = case new.status
                   when 'open'        then 'acknowledged'::request_status
                   when 'in_progress' then 'in_progress'::request_status
                   when 'on_hold'     then 'acknowledged'::request_status
                   when 'completed'   then 'resolved'::request_status
                   when 'cancelled'   then 'closed'::request_status
                 end,
        resolved_at = case when new.status = 'completed' then now() else resolved_at end
    where work_order_id = new.id
      and status not in ('resolved', 'closed');
  end if;
  return new;
end;
$$;

revoke execute on function public.sync_request_from_work_order() from public, anon, authenticated;

create trigger trg_sync_request_from_work_order
  after update on public.work_orders
  for each row execute function public.sync_request_from_work_order();

-- ---------------------------------------------------------------------------
-- rent_payments — owner records; tenant of the lease can read
-- ---------------------------------------------------------------------------
create table public.rent_payments (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  lease_id   uuid not null references public.leases(id) on delete cascade,
  amount     numeric(12,2) not null,
  currency   text not null default 'USD',
  due_date   date,
  paid_on    date,
  method     payment_method,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_rent_payments_owner on public.rent_payments(owner_id);
create index idx_rent_payments_lease on public.rent_payments(lease_id, due_date);

create trigger trg_rent_payments_updated_at
  before update on public.rent_payments
  for each row execute function public.set_updated_at();

alter table public.rent_payments enable row level security;

create policy "owner_select_rent_payments" on public.rent_payments
  for select using (owner_id = auth.uid());
create policy "owner_insert_rent_payments" on public.rent_payments
  for insert with check (owner_id = auth.uid());
create policy "owner_update_rent_payments" on public.rent_payments
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner_delete_rent_payments" on public.rent_payments
  for delete using (owner_id = auth.uid());

create policy "tenant_select_rent_payments" on public.rent_payments
  for select using (public.is_tenant_of_lease(lease_id));

-- ---------------------------------------------------------------------------
-- announcements — owner broadcasts (property_id null = whole portfolio)
-- ---------------------------------------------------------------------------
create table public.announcements (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  property_id uuid references public.properties(id) on delete cascade,
  title       text not null,
  body        text,
  created_at  timestamptz not null default now()
);

create index idx_announcements_owner on public.announcements(owner_id);

alter table public.announcements enable row level security;

create policy "owner_select_announcements" on public.announcements
  for select using (owner_id = auth.uid());
create policy "owner_insert_announcements" on public.announcements
  for insert with check (owner_id = auth.uid());
create policy "owner_update_announcements" on public.announcements
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner_delete_announcements" on public.announcements
  for delete using (owner_id = auth.uid());

-- Tenants see announcements from their landlord that target their property
-- (or the landlord's whole portfolio).
create policy "tenant_select_announcements" on public.announcements
  for select using (
    exists (
      select 1 from public.tenant_lease_details d
      where d.owner_id = announcements.owner_id
        and (announcements.property_id is null
             or announcements.property_id = d.property_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Storage: request photos live under attachments/requests/<request_id>/...
-- Visible to both participants of the request. The existing <uid>/ policies
-- are untouched ('requests' can never collide with a uuid folder name).
-- ---------------------------------------------------------------------------
create policy "request_photos_select"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = 'requests'
    and exists (
      select 1 from public.maintenance_requests r
      where r.id::text = (storage.foldername(name))[2]
        and (r.owner_id = auth.uid() or r.tenant_user_id = auth.uid())
    )
  );

create policy "request_photos_insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = 'requests'
    and exists (
      select 1 from public.maintenance_requests r
      where r.id::text = (storage.foldername(name))[2]
        and (r.owner_id = auth.uid() or r.tenant_user_id = auth.uid())
    )
  );
