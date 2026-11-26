-- RentView trust, operations and backend reliability.
-- Created with the Supabase CLI after validation in disposable local Supabase/PostgreSQL17.
-- This migration has not been applied to a hosted project.
-- Review read-only preflight output and reconcile legacy rows before rollout.
-- Apply once, in one transaction, after checked-in migrations 0001..0009.
-- Never run tests/db fixtures on a hosted/shared database.
-- Existing data is retained. The added NOT VALID constraints enforce new writes
-- but leave old rows pending explicit reconciliation and validation. Review the
-- aggregate preflight output and legacy subscription provenance before rollout.
-- Retention behavior: unlinking a tenant revokes future request/message/Storage
-- authorization; already issued signed object URLs expire independently.
-- Tenant identity deletion anonymizes repair participants and preserves owner
-- history. Owner/property deletion still follows existing cascade semantics.
-- Billing events during deletion remain factual; renewable billing blocks final
-- Auth deletion. Late external checkout after identity deletion requires provider
-- reconciliation; backend cannot cancel a provider session it does not own.

-- Fail before any trust/entitlement changes if legacy paid/provider-linked rows
-- have no independently reviewed decision. The optional private ledger is created
-- only by the operator bootstrap; old client-writable rows are never proof.
do $$ declare unresolved bigint; begin
  lock table public.subscriptions in share row exclusive mode;
  if exists(select 1 from public.subscriptions where plan='pro' or provider_subscription_id is not null) then
    if to_regclass('rentview_private.legacy_billing_reconciliation') is null then
      raise exception 'Legacy billing reconciliation required before migration' using errcode='23514';
    end if;
    lock table rentview_private.legacy_billing_reconciliation in share mode;
    if has_table_privilege('authenticated','rentview_private.legacy_billing_reconciliation','INSERT,UPDATE,DELETE,SELECT')
       or has_table_privilege('anon','rentview_private.legacy_billing_reconciliation','INSERT,UPDATE,DELETE,SELECT') then
      raise exception 'Legacy billing evidence ledger must be operator-only' using errcode='42501';
    end if;
    select count(*) into unresolved from public.subscriptions s
      where (s.plan='pro' or s.provider_subscription_id is not null) and not exists(
        select 1 from rentview_private.legacy_billing_reconciliation r
        where r.owner_id=s.owner_id and r.legacy_snapshot=to_jsonb(s)
          and r.decision in ('verified','rejected'));
    if unresolved<>0 then
      raise exception 'Legacy billing reconciliation required before migration (% unresolved accounts)',unresolved using errcode='23514';
    end if;
  end if;
end $$;

-- RentView: trusted ownership boundaries and atomic maintenance operations.
-- Existing records are retained. NOT VALID constraints protect new writes while
-- allowing administrators to inspect and repair any legacy inconsistency first.
create schema if not exists rentview_private;
revoke all on schema rentview_private from public, anon;
grant usage on schema rentview_private to authenticated, service_role;

-- A copied JWT cannot keep a deleted identity alive. The backend migration
-- extends this predicate to accounts whose deletion has started.
create or replace function public.current_account_is_active()
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from auth.users u where u.id=(select auth.uid()));
$$;
revoke all on function public.current_account_is_active() from public,anon;
grant execute on function public.current_account_is_active() to authenticated,service_role;

revoke all on all tables in schema public from public, anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;

drop policy if exists owner_insert_subscriptions on public.subscriptions;
drop policy if exists owner_update_subscriptions on public.subscriptions;
drop policy if exists owner_delete_subscriptions on public.subscriptions;
revoke insert, update, delete on public.subscriptions from authenticated;
grant select on public.subscriptions to authenticated;

-- Relationship constraints include ownership, rather than relying on unrelated
-- UUID foreign keys. API RLS remains the actor check; these are domain checks.
create unique index if not exists properties_id_owner_key on public.properties(id, owner_id);
create unique index if not exists units_id_owner_key on public.units(id, owner_id);
create unique index if not exists leases_id_owner_key on public.leases(id, owner_id);
create unique index if not exists assets_id_owner_key on public.assets(id, owner_id);
create unique index if not exists work_orders_id_owner_key on public.work_orders(id, owner_id);
create unique index if not exists inventory_items_id_owner_key on public.inventory_items(id, owner_id);
create unique index if not exists vendors_id_owner_key on public.vendors(id, owner_id);
create unique index if not exists maintenance_schedules_id_owner_key on public.maintenance_schedules(id, owner_id);
create unique index if not exists units_id_property_owner_key on public.units(id, property_id, owner_id);
create unique index if not exists assets_id_property_owner_key on public.assets(id, property_id, owner_id);
create unique index if not exists work_orders_id_property_owner_key on public.work_orders(id, property_id, owner_id);
create unique index if not exists leases_id_unit_owner_key on public.leases(id, unit_id, owner_id);
alter table public.units add constraint units_property_id_owner_fk foreign key (property_id, owner_id) references public.properties(id, owner_id) not valid;
alter table public.leases add constraint leases_unit_id_owner_fk foreign key (unit_id, owner_id) references public.units(id, owner_id) not valid;
alter table public.assets add constraint assets_property_id_owner_fk foreign key (property_id, owner_id) references public.properties(id, owner_id) not valid;
alter table public.assets add constraint assets_unit_id_owner_fk foreign key (unit_id, owner_id) references public.units(id, owner_id) not valid;
alter table public.work_orders add constraint work_orders_property_id_owner_fk foreign key (property_id, owner_id) references public.properties(id, owner_id) not valid;
alter table public.work_orders add constraint work_orders_unit_id_owner_fk foreign key (unit_id, owner_id) references public.units(id, owner_id) not valid;
alter table public.work_orders add constraint work_orders_asset_id_owner_fk foreign key (asset_id, owner_id) references public.assets(id, owner_id) not valid;
alter table public.work_orders add constraint work_orders_vendor_id_owner_fk foreign key (vendor_id, owner_id) references public.vendors(id, owner_id) not valid;
alter table public.inventory_items add constraint inventory_items_property_id_owner_fk foreign key (property_id, owner_id) references public.properties(id, owner_id) not valid;
alter table public.inventory_items add constraint inventory_items_unit_id_owner_fk foreign key (unit_id, owner_id) references public.units(id, owner_id) not valid;
alter table public.work_order_parts add constraint work_order_parts_work_order_id_owner_fk foreign key (work_order_id, owner_id) references public.work_orders(id, owner_id) not valid;
alter table public.work_order_parts add constraint work_order_parts_inventory_item_id_owner_fk foreign key (inventory_item_id, owner_id) references public.inventory_items(id, owner_id) not valid;
alter table public.expenses add constraint expenses_property_id_owner_fk foreign key (property_id, owner_id) references public.properties(id, owner_id) not valid;
alter table public.expenses add constraint expenses_unit_id_owner_fk foreign key (unit_id, owner_id) references public.units(id, owner_id) not valid;
alter table public.expenses add constraint expenses_work_order_id_owner_fk foreign key (work_order_id, owner_id) references public.work_orders(id, owner_id) not valid;
alter table public.expenses add constraint expenses_vendor_id_owner_fk foreign key (vendor_id, owner_id) references public.vendors(id, owner_id) not valid;
alter table public.maintenance_schedules add constraint maintenance_schedules_property_id_owner_fk foreign key (property_id, owner_id) references public.properties(id, owner_id) not valid;
alter table public.maintenance_schedules add constraint maintenance_schedules_unit_id_owner_fk foreign key (unit_id, owner_id) references public.units(id, owner_id) not valid;
alter table public.maintenance_schedules add constraint maintenance_schedules_asset_id_owner_fk foreign key (asset_id, owner_id) references public.assets(id, owner_id) not valid;
alter table public.documents add constraint documents_property_id_owner_fk foreign key (property_id, owner_id) references public.properties(id, owner_id) not valid;
alter table public.documents add constraint documents_unit_id_owner_fk foreign key (unit_id, owner_id) references public.units(id, owner_id) not valid;
alter table public.documents add constraint documents_asset_id_owner_fk foreign key (asset_id, owner_id) references public.assets(id, owner_id) not valid;
alter table public.documents add constraint documents_work_order_id_owner_fk foreign key (work_order_id, owner_id) references public.work_orders(id, owner_id) not valid;
alter table public.tasks add constraint tasks_property_id_owner_fk foreign key (property_id, owner_id) references public.properties(id, owner_id) not valid;
alter table public.tasks add constraint tasks_unit_id_owner_fk foreign key (unit_id, owner_id) references public.units(id, owner_id) not valid;
alter table public.tenant_invites add constraint tenant_invites_lease_id_owner_fk foreign key (lease_id, owner_id) references public.leases(id, owner_id) not valid;
alter table public.maintenance_requests add constraint maintenance_requests_lease_id_owner_fk foreign key (lease_id, owner_id) references public.leases(id, owner_id) not valid;
alter table public.maintenance_requests add constraint maintenance_requests_unit_id_owner_fk foreign key (unit_id, owner_id) references public.units(id, owner_id) not valid;
alter table public.maintenance_requests add constraint maintenance_requests_property_id_owner_fk foreign key (property_id, owner_id) references public.properties(id, owner_id) not valid;
alter table public.maintenance_requests add constraint maintenance_requests_work_order_id_owner_fk foreign key (work_order_id, owner_id) references public.work_orders(id, owner_id) not valid;
alter table public.rent_payments add constraint rent_payments_lease_id_owner_fk foreign key (lease_id, owner_id) references public.leases(id, owner_id) not valid;
alter table public.announcements add constraint announcements_property_id_owner_fk foreign key (property_id, owner_id) references public.properties(id, owner_id) not valid;
alter table public.assets add constraint assets_unit_property_owner_fk foreign key (unit_id, property_id, owner_id) references public.units(id, property_id, owner_id) not valid;
alter table public.work_orders add constraint work_orders_unit_property_owner_fk foreign key (unit_id, property_id, owner_id) references public.units(id, property_id, owner_id) not valid;
alter table public.inventory_items add constraint inventory_items_unit_property_owner_fk foreign key (unit_id, property_id, owner_id) references public.units(id, property_id, owner_id) not valid;
alter table public.expenses add constraint expenses_unit_property_owner_fk foreign key (unit_id, property_id, owner_id) references public.units(id, property_id, owner_id) not valid;
alter table public.maintenance_schedules add constraint maintenance_schedules_unit_property_owner_fk foreign key (unit_id, property_id, owner_id) references public.units(id, property_id, owner_id) not valid;
alter table public.documents add constraint documents_unit_property_owner_fk foreign key (unit_id, property_id, owner_id) references public.units(id, property_id, owner_id) not valid;
alter table public.tasks add constraint tasks_unit_property_owner_fk foreign key (unit_id, property_id, owner_id) references public.units(id, property_id, owner_id) not valid;
alter table public.maintenance_requests add constraint maintenance_requests_unit_property_owner_fk foreign key (unit_id, property_id, owner_id) references public.units(id, property_id, owner_id) not valid;
alter table public.work_orders add constraint work_orders_asset_property_owner_fk foreign key (asset_id, property_id, owner_id) references public.assets(id, property_id, owner_id) not valid;
alter table public.maintenance_schedules add constraint maintenance_schedules_asset_property_owner_fk foreign key (asset_id, property_id, owner_id) references public.assets(id, property_id, owner_id) not valid;
alter table public.documents add constraint documents_asset_property_owner_fk foreign key (asset_id, property_id, owner_id) references public.assets(id, property_id, owner_id) not valid;
alter table public.expenses add constraint expenses_job_property_owner_fk foreign key (work_order_id, property_id, owner_id) references public.work_orders(id, property_id, owner_id) not valid;
alter table public.documents add constraint documents_job_property_owner_fk foreign key (work_order_id, property_id, owner_id) references public.work_orders(id, property_id, owner_id) not valid;
alter table public.maintenance_requests add constraint maintenance_requests_job_property_owner_fk foreign key (work_order_id, property_id, owner_id) references public.work_orders(id, property_id, owner_id) not valid;
alter table public.maintenance_requests add constraint requests_lease_unit_owner_fk foreign key (lease_id, unit_id, owner_id) references public.leases(id, unit_id, owner_id) not valid;

create or replace function rentview_private.guard_row_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id then
    raise exception 'Record identity and ownership cannot be changed' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function rentview_private.guard_row_identity() from public, anon, authenticated;
do $$ declare t text; begin
  foreach t in array array['properties','units','leases','vendors','assets','work_orders','inventory_items','work_order_parts','expenses','tasks','maintenance_schedules','documents','tenant_invites','maintenance_requests','rent_payments','announcements'] loop
    execute format('create trigger guard_identity before update on public.%I for each row execute function rentview_private.guard_row_identity()', t);
  end loop;
end $$;

create or replace function rentview_private.guard_scoped_relations()
returns trigger language plpgsql security definer set search_path = '' as $$
declare d jsonb := to_jsonb(new); parent jsonb; col text; parent_table text; parent_id uuid;
begin
  foreach col in array array['unit_id','asset_id','work_order_id'] loop
    if d ? col and d->>col is not null then
      if d ? 'property_id' and d->>'property_id' is null then
        raise exception 'A location is required for the linked record' using errcode = '23514';
      end if;
      parent_table := case col when 'unit_id' then 'units' when 'asset_id' then 'assets' else 'work_orders' end;
      parent_id := (d->>col)::uuid;
      execute format('select to_jsonb(p) from public.%I p where id = $1 and owner_id = $2', parent_table)
        into parent using parent_id, (d->>'owner_id')::uuid;
      if parent is null then raise exception 'Linked record does not belong to this owner' using errcode = '23514'; end if;
      if d ? 'property_id' and parent->>'property_id' is distinct from d->>'property_id' then
        raise exception 'Linked record belongs to another property' using errcode = '23514';
      end if;
      if col <> 'unit_id' and parent->>'unit_id' is not null and d->>'unit_id' is not null
          and parent->>'unit_id' <> d->>'unit_id' then
        raise exception 'Linked record belongs to another unit' using errcode = '23514';
      end if;
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function rentview_private.guard_scoped_relations() from public, anon, authenticated;
do $$ declare t text; begin
  foreach t in array array['assets','work_orders','inventory_items','expenses','maintenance_schedules','documents','tasks','maintenance_requests'] loop
    execute format('create trigger guard_scope before insert or update on public.%I for each row execute function rentview_private.guard_scoped_relations()', t);
  end loop;
end $$;

-- A customer cannot change their routing role or directly install another user
-- as a lease tenant. Claiming a validated invite is the only link operation.
create or replace function rentview_private.guard_profile_role()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated','anon') and (
    (tg_op = 'INSERT' and new.role <> 'owner') or
    (tg_op = 'UPDATE' and (new.role is distinct from old.role or new.id is distinct from old.id))
  ) then raise exception 'Role changes require a validated membership action' using errcode = '42501'; end if;
  return new;
end;
$$;
create trigger guard_profile_role before insert or update on public.profiles for each row execute function rentview_private.guard_profile_role();
revoke all on function rentview_private.guard_profile_role() from public, anon, authenticated;

create or replace function rentview_private.guard_lease_tenant()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated','anon') then
    if tg_op = 'INSERT' and new.tenant_user_id is not null then
      raise exception 'Portal access must be claimed through an invitation' using errcode='42501';
    elsif tg_op = 'UPDATE' and new.tenant_user_id is distinct from old.tenant_user_id and new.tenant_user_id is not null then
      raise exception 'Portal access must be claimed through an invitation' using errcode='42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger guard_lease_tenant before insert or update on public.leases for each row execute function rentview_private.guard_lease_tenant();
revoke all on function rentview_private.guard_lease_tenant() from public, anon, authenticated;

create or replace function rentview_private.enforce_property_capacity()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;
  if new.owner_id <> auth.uid() then raise exception 'Not authorized' using errcode='42501'; end if;
  -- Let a stable-ID retry reach the normal unique conflict so the client can
  -- verify the originally committed payload even when the account is at cap.
  if exists(select 1 from public.properties p where p.id=new.id and p.owner_id=new.owner_id) then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.owner_id::text, 611));
  if exists(select 1 from public.subscriptions s where s.owner_id=new.owner_id and s.plan='pro' and to_jsonb(s)->>'billing_verified_at' is not null and
      (s.status in ('active','trialing','past_due') or (s.status='cancelled' and s.current_period_end > now()))) then
    return new;
  end if;
  if (select count(*) from public.properties p where p.owner_id=new.owner_id) >= 3 then
    raise exception 'Free includes three properties. Upgrade to add another.' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger enforce_property_capacity before insert on public.properties for each row execute function rentview_private.enforce_property_capacity();
revoke all on function rentview_private.enforce_property_capacity() from public, anon, authenticated;

-- History belongs to the property. Identity removal anonymizes the participant
-- rather than erasing an owner's repair history through an auth-user cascade.
alter table public.maintenance_requests drop constraint maintenance_requests_tenant_user_id_fkey;
alter table public.maintenance_requests alter column tenant_user_id drop not null;
alter table public.maintenance_requests add constraint maintenance_requests_tenant_user_id_fkey foreign key (tenant_user_id) references auth.users(id) on delete set null;
alter table public.request_messages drop constraint request_messages_sender_id_fkey;
alter table public.request_messages alter column sender_id drop not null;
alter table public.request_messages add constraint request_messages_sender_id_fkey foreign key (sender_id) references auth.users(id) on delete set null;

-- These narrowly scoped predicates intentionally look through owner-only lease
-- RLS. They return only an authorization boolean, never other users' rows.
create or replace function public.is_tenant_of_lease(p_lease uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.leases l join public.units u on u.id=l.unit_id and u.owner_id=l.owner_id
    join public.properties p on p.id=u.property_id and p.owner_id=l.owner_id
    where l.id=p_lease and l.tenant_user_id=(select auth.uid()) and public.current_account_is_active());
$$;
create or replace function public.tenant_lease_matches(p_lease uuid,p_unit uuid,p_property uuid,p_owner uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.leases l join public.units u on u.id=l.unit_id and u.owner_id=l.owner_id
    join public.properties p on p.id=u.property_id and p.owner_id=l.owner_id
    where l.id=p_lease and l.tenant_user_id=(select auth.uid()) and l.status='active'
      and l.unit_id=p_unit and u.property_id=p_property and l.owner_id=p_owner and public.current_account_is_active());
$$;
create or replace function public.can_access_request(p_request_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.maintenance_requests r
    join public.leases l on l.id=r.lease_id and l.owner_id=r.owner_id and l.unit_id=r.unit_id
    join public.units u on u.id=r.unit_id and u.property_id=r.property_id and u.owner_id=r.owner_id
    where r.id=p_request_id and public.current_account_is_active() and ((r.owner_id=(select auth.uid())) or
      (r.tenant_user_id=(select auth.uid()) and l.tenant_user_id=(select auth.uid()))));
$$;
revoke all on function public.can_access_request(uuid) from public, anon;
grant execute on function public.can_access_request(uuid) to authenticated, service_role;
revoke all on function public.is_tenant_of_lease(uuid), public.tenant_lease_matches(uuid,uuid,uuid,uuid) from public, anon;
grant execute on function public.is_tenant_of_lease(uuid), public.tenant_lease_matches(uuid,uuid,uuid,uuid) to authenticated, service_role;

-- A tenant can read a deliberately redacted membership projection without
-- gaining SELECT policies on owner-private base tables. The private helper
-- accepts no actor input, derives identity from the verified request context,
-- and returns only the existing approved columns. The exposed view itself
-- uses the caller's privileges; only this scoped function crosses RLS.
create or replace function rentview_private.current_tenant_lease_details()
returns table(
 lease_id uuid,unit_id uuid,owner_id uuid,start_date date,end_date date,rent_amount numeric,rent_currency text,
 deposit_amount numeric,status public.lease_status,unit_label text,unit_type public.unit_type,property_id uuid,
 property_name text,address_line1 text,city text,region text,country text,landlord_name text
)
language sql stable security definer set search_path='' as $$
select l.id as lease_id,l.unit_id,l.owner_id,l.start_date,l.end_date,l.rent_amount,l.rent_currency,l.deposit_amount,l.status,
  u.label as unit_label,u.unit_type,u.property_id,p.name as property_name,p.address_line1,p.city,p.region,p.country,pr.full_name as landlord_name
from public.leases l
join public.units u on u.id=l.unit_id and u.owner_id=l.owner_id
join public.properties p on p.id=u.property_id and p.owner_id=l.owner_id
left join public.profiles pr on pr.id=l.owner_id
where l.tenant_user_id=(select auth.uid()) and public.current_account_is_active();
$$;
revoke all on function rentview_private.current_tenant_lease_details() from public,anon,service_role;
grant execute on function rentview_private.current_tenant_lease_details() to authenticated;
create or replace view public.tenant_lease_details with (security_invoker=true,security_barrier=true) as
select d.lease_id,d.unit_id,d.owner_id,d.start_date,d.end_date,d.rent_amount::numeric(12,2) as rent_amount,d.rent_currency,
 d.deposit_amount::numeric(12,2) as deposit_amount,d.status,d.unit_label,d.unit_type,d.property_id,d.property_name,
 d.address_line1,d.city,d.region,d.country,d.landlord_name
from rentview_private.current_tenant_lease_details() d;
revoke all on public.tenant_lease_details from public,anon;
grant select on public.tenant_lease_details to authenticated;

-- Invites are random server-generated secrets, bound to one currently unlinked
-- lease. Direct writes are removed so timestamps, code and claim state cannot
-- be forged through the Data API.
drop policy if exists owner_insert_tenant_invites on public.tenant_invites;
drop policy if exists owner_update_tenant_invites on public.tenant_invites;
revoke insert,update on public.tenant_invites from authenticated;
create or replace function public.create_tenant_invite(p_lease_id uuid,p_email text default null)
returns public.tenant_invites language plpgsql security definer set search_path = '' as $$
declare l public.leases%rowtype; invitation public.tenant_invites%rowtype; uid uuid:=auth.uid();
begin
  if uid is null or not public.current_account_is_active() then raise exception 'Not authenticated' using errcode='42501'; end if;
  select * into l from public.leases where id=p_lease_id and owner_id=uid for update;
  if not found or not exists(select 1 from public.units u join public.properties p on p.id=u.property_id and p.owner_id=u.owner_id where u.id=l.unit_id and u.owner_id=uid) then
    raise exception 'Lease not found' using errcode='42501';
  end if;
  if l.status<>'active' or l.tenant_user_id is not null then raise exception 'Only an active lease without portal access can be invited' using errcode='23514'; end if;
  if p_email is not null and (length(trim(p_email))>254 or trim(p_email) !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then raise exception 'Invalid invitation email' using errcode='23514'; end if;
  delete from public.tenant_invites where lease_id=l.id and claimed_at is null;
  insert into public.tenant_invites(owner_id,lease_id,code,email)
    values(uid,l.id,upper(replace(pg_catalog.gen_random_uuid()::text,'-','')),nullif(lower(trim(p_email)),'')) returning * into invitation;
  return invitation;
end;
$$;
create or replace function public.claim_tenant_invite(invite_code text)
returns json language plpgsql security definer set search_path = '' as $$
declare invitation public.tenant_invites%rowtype; l public.leases%rowtype; uid uuid:=auth.uid(); user_email text;
begin
  if uid is null or not public.current_account_is_active() then raise exception 'Not authenticated' using errcode='42501'; end if;
  if invite_code is null or length(invite_code)>128 then raise exception 'Invalid or expired invitation' using errcode='23514'; end if;
  -- Resolve first, lock the lease first, then the invite. All invitation paths
  -- use this lock order, avoiding deadlocks between create/claim/revoke.
  select * into invitation from public.tenant_invites where code=upper(trim(invite_code));
  if not found then raise exception 'Invalid or expired invitation' using errcode='23514'; end if;
  select * into l from public.leases where id=invitation.lease_id for update;
  select * into invitation from public.tenant_invites where id=invitation.id for update;
  if found and invitation.claimed_at is not null and invitation.claimed_by=uid and l.tenant_user_id=uid and l.owner_id=invitation.owner_id then
    return json_build_object('lease_id',l.id);
  end if;
  if not found or invitation.claimed_at is not null or invitation.expires_at<=now() or invitation.owner_id=uid
    or l.owner_id is distinct from invitation.owner_id or l.status<>'active' or l.tenant_user_id is not null
    or not exists(select 1 from public.units u join public.properties p on p.id=u.property_id and p.owner_id=u.owner_id where u.id=l.unit_id and u.owner_id=l.owner_id) then
    raise exception 'Invalid or expired invitation' using errcode='23514';
  end if;
  if invitation.email is not null then
    select lower(email) into user_email from auth.users where id=uid and email_confirmed_at is not null;
    if user_email is distinct from lower(trim(invitation.email)) then
      raise exception 'Sign in with the verified email address this invitation was sent to' using errcode='42501';
    end if;
  end if;
  update public.leases set tenant_user_id=uid where id=l.id;
  update public.profiles set role='tenant' where id=uid and role='owner' and not exists(select 1 from public.properties p where p.owner_id=uid);
  update public.tenant_invites set claimed_by=uid,claimed_at=now() where id=invitation.id;
  delete from public.tenant_invites where lease_id=l.id and id<>invitation.id and claimed_at is null;
  return json_build_object('lease_id',l.id);
end;
$$;
revoke all on function public.create_tenant_invite(uuid,text),public.claim_tenant_invite(text) from public,anon;
grant execute on function public.create_tenant_invite(uuid,text),public.claim_tenant_invite(text) to authenticated;

-- Tenant input never supplies internal work/status/rating state. Broad tenant
-- UPDATE is removed; constrained RPCs below implement allowed transitions.
drop policy if exists owner_insert_requests on public.maintenance_requests;
drop policy if exists tenant_select_requests on public.maintenance_requests;
drop policy if exists tenant_insert_requests on public.maintenance_requests;
drop policy if exists tenant_update_requests on public.maintenance_requests;
create policy tenant_select_requests on public.maintenance_requests for select to authenticated
  -- Authorize from the new row's scope instead of re-reading its request ID.
  -- A STABLE request lookup cannot see a row during INSERT RETURNING, so it
  -- would reject a legitimate tenant create with return=representation.
  using (tenant_user_id=(select auth.uid()) and exists(
    select 1 from public.tenant_lease_details d
    where d.lease_id=maintenance_requests.lease_id and d.unit_id=maintenance_requests.unit_id
      and d.property_id=maintenance_requests.property_id and d.owner_id=maintenance_requests.owner_id));
create policy tenant_insert_requests on public.maintenance_requests for insert to authenticated with check (
 tenant_user_id=(select auth.uid()) and public.tenant_lease_matches(lease_id,unit_id,property_id,owner_id)
 and status='submitted' and work_order_id is null and rating is null and rating_comment is null and resolved_at is null);

create or replace function rentview_private.guard_request_scope()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.lease_id is distinct from old.lease_id or new.unit_id is distinct from old.unit_id or new.property_id is distinct from old.property_id then
    raise exception 'Request location cannot be reassigned' using errcode='23514';
  end if;
  if current_user in ('authenticated','anon') and (new.rating is distinct from old.rating or new.rating_comment is distinct from old.rating_comment) then
    raise exception 'Only the tenant can rate a resolution' using errcode='42501';
  end if;
  if new.tenant_user_id is distinct from old.tenant_user_id and current_user in ('authenticated','anon') then
    raise exception 'Request participant cannot be reassigned' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger guard_request_scope before update on public.maintenance_requests for each row execute function rentview_private.guard_request_scope();
revoke all on function rentview_private.guard_request_scope() from public,anon,authenticated;

-- Read and write authorization for both metadata and object bytes follows the
-- current lease association. Old signed URLs expire separately at Storage.
drop policy participants_select_request_messages on public.request_messages;
drop policy participants_insert_request_messages on public.request_messages;
create policy participants_select_request_messages on public.request_messages for select to authenticated using(public.can_access_request(request_id));
create policy participants_insert_request_messages on public.request_messages for insert to authenticated with check (
 sender_id=(select auth.uid()) and public.can_access_request(request_id) and
 exists(select 1 from public.maintenance_requests r where r.id=request_id and r.status<>'closed'));
drop policy participants_select_request_photos on public.request_photos;
drop policy participants_insert_request_photos on public.request_photos;
create policy participants_select_request_photos on public.request_photos for select to authenticated using(public.can_access_request(request_id));
create policy participants_insert_request_photos on public.request_photos for insert to authenticated with check (
 public.can_access_request(request_id) and exists(select 1 from public.maintenance_requests r where r.id=request_id and r.status<>'closed'));
alter table public.request_photos add constraint request_photo_path_matches check (
 split_part(storage_path,'/',1)='requests' and split_part(storage_path,'/',2)=request_id::text
 and split_part(storage_path,'/',3)<>'' and storage_path !~ '(^|/)\.\.(/|$)') not valid;
alter table public.request_messages add constraint request_message_nonblank check(length(trim(body)) between 1 and 10000) not valid;

drop policy request_photos_select on storage.objects;
drop policy request_photos_insert on storage.objects;
create policy request_photos_select on storage.objects for select to authenticated using (
 bucket_id='attachments' and (storage.foldername(name))[1]='requests'
 and exists(select 1 from public.maintenance_requests r where r.id::text=(storage.foldername(name))[2] and public.can_access_request(r.id)));
create policy request_photos_insert on storage.objects for insert to authenticated with check (
 bucket_id='attachments' and (storage.foldername(name))[1]='requests'
 and exists(select 1 from public.maintenance_requests r where r.id::text=(storage.foldername(name))[2] and r.status<>'closed' and public.can_access_request(r.id)));

create or replace function public.close_tenant_request(p_request_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests%rowtype;
begin
  select * into r from public.maintenance_requests where id=p_request_id for update;
  if not found or auth.uid() is null or r.tenant_user_id is distinct from auth.uid() or not public.can_access_request(r.id) then raise exception 'Request not found' using errcode='42501'; end if;
  if r.status='closed' then return; end if;
  if r.status<>'resolved' then raise exception 'Only a resolved request can be closed' using errcode='23514'; end if;
  update public.maintenance_requests set status='closed' where id=r.id;
end;
$$;
create or replace function public.rate_request_resolution(p_request_id uuid,p_rating integer,p_comment text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests%rowtype;
begin
  select * into r from public.maintenance_requests where id=p_request_id for update;
  if not found or auth.uid() is null or r.tenant_user_id is distinct from auth.uid() or not public.can_access_request(r.id) then raise exception 'Request not found' using errcode='42501'; end if;
  if p_rating is null or p_rating not between 1 and 5 or length(coalesce(p_comment,''))>2000 then raise exception 'Choose a rating from 1 to 5' using errcode='23514'; end if;
  if r.status not in ('resolved','closed') then raise exception 'The repair must be resolved before rating' using errcode='23514'; end if;
  if r.rating is not null then
    if r.rating=p_rating and coalesce(r.rating_comment,'')=coalesce(nullif(trim(p_comment),''),'') then return; end if;
    raise exception 'This resolution has already been rated' using errcode='23514';
  end if;
  update public.maintenance_requests set rating=p_rating,rating_comment=nullif(trim(p_comment),'') where id=r.id;
end;
$$;
create or replace function public.reopen_tenant_request(p_request_id uuid,p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests%rowtype;
begin
  select * into r from public.maintenance_requests where id=p_request_id for update;
  if not found or auth.uid() is null or r.tenant_user_id is distinct from auth.uid() or not public.can_access_request(r.id) then raise exception 'Request not found' using errcode='42501'; end if;
  if length(trim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'Explain what still needs attention' using errcode='23514'; end if;
  if r.status not in ('resolved','closed') then raise exception 'Only resolved or closed requests can be reopened' using errcode='23514'; end if;
  -- Preserve the completed job as history; the reopened request is triaged
  -- into a new job instead of silently rewriting a posted job's costs.
  update public.maintenance_requests set status='submitted',work_order_id=null,resolved_at=null,rating=null,rating_comment=null where id=r.id;
  insert into public.request_messages(request_id,sender_id,body) values(r.id,auth.uid(),'Still not fixed: '||trim(p_reason));
end;
$$;
revoke all on function public.close_tenant_request(uuid),public.rate_request_resolution(uuid,integer,text),public.reopen_tenant_request(uuid,text) from public,anon;
grant execute on function public.close_tenant_request(uuid),public.rate_request_resolution(uuid,integer,text),public.reopen_tenant_request(uuid,text) to authenticated;

create or replace function public.convert_request_to_work_order(p_request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests%rowtype; job_id uuid;
begin
  select * into r from public.maintenance_requests where id=p_request_id and owner_id=auth.uid() for update;
  if not found or auth.uid() is null then raise exception 'Request not found' using errcode='42501'; end if;
  if r.work_order_id is not null then return r.work_order_id; end if;
  if r.status in ('resolved','closed') then raise exception 'Reopen the request before creating another job' using errcode='23514'; end if;
  insert into public.work_orders(owner_id,property_id,unit_id,title,description,priority,status)
    values(r.owner_id,r.property_id,r.unit_id,r.title,r.description,r.urgency,'open') returning id into job_id;
  update public.maintenance_requests set work_order_id=job_id,status='acknowledged' where id=r.id;
  return job_id;
end;
$$;
revoke all on function public.convert_request_to_work_order(uuid) from public,anon;
grant execute on function public.convert_request_to_work_order(uuid) to authenticated;

-- Numeric/domain checks reject NaN as well as negative values. NOT VALID keeps
-- migration non-destructive; all future writes must satisfy the new rules.
alter table public.properties add constraint property_currency check(currency ~ '^[A-Z]{3}$') not valid;
alter table public.properties add constraint property_estimated_value_finite check(estimated_value is null or estimated_value not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)) not valid;
alter table public.units add constraint unit_bathrooms_finite check(bathrooms is null or bathrooms not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)) not valid;
alter table public.assets add constraint asset_purchase_cost_finite check(purchase_cost is null or purchase_cost not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)) not valid;
alter table public.work_orders add constraint work_order_cost_finite check(cost is null or cost not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)) not valid;
alter table public.units add constraint unit_area_and_rent check(
  (size_value is null or (size_value>=0 and size_value<>'NaN'::numeric)) and size_unit in ('sqft','sqm') and
  (rent_amount is null or (rent_amount>=0 and rent_amount<>'NaN'::numeric)) and
  (rent_currency is null or rent_currency ~ '^[A-Z]{3}$')) not valid;
alter table public.leases add constraint lease_dates_and_amounts check(
 (end_date is null or start_date is null or end_date>=start_date) and
 (rent_amount is null or (rent_amount>=0 and rent_amount<>'NaN'::numeric)) and
 (deposit_amount is null or (deposit_amount>=0 and deposit_amount<>'NaN'::numeric)) and
 (rent_currency is null or rent_currency ~ '^[A-Z]{3}$')) not valid;
alter table public.expenses add constraint expense_amount_and_currency check(amount>=0 and amount<>'NaN'::numeric and currency ~ '^[A-Z]{3}$') not valid;
alter table public.rent_payments add constraint rent_amount_and_currency check(amount>0 and amount<>'NaN'::numeric and currency ~ '^[A-Z]{3}$') not valid;
alter table public.inventory_items add constraint stock_amounts check(
 quantity>=0 and quantity<>'NaN'::numeric and
 (unit_cost is null or (unit_cost>=0 and unit_cost<>'NaN'::numeric)) and
 (low_stock_threshold is null or (low_stock_threshold>=0 and low_stock_threshold<>'NaN'::numeric)) and
 (cost_currency is null or cost_currency ~ '^[A-Z]{3}$')) not valid;
alter table public.work_order_parts add constraint part_amounts check(quantity>0 and quantity<>'NaN'::numeric and
 (unit_cost is null or (unit_cost>=0 and unit_cost<>'NaN'::numeric)) and
 (cost_currency is null or cost_currency ~ '^[A-Z]{3}$')) not valid;
alter table public.maintenance_schedules add constraint custom_schedule_interval check(frequency<>'custom' or (interval_days is not null and interval_days between 1 and 36500)) not valid;
alter table public.maintenance_requests add constraint request_title_nonblank check(length(trim(title)) between 1 and 500) not valid;

alter table public.work_order_parts add column operation_input jsonb;
alter table public.work_order_parts add column removed_at timestamptz;
-- Completion pointers form a history cycle with expenses.work_order_id.
-- Deferred NO ACTION permits a whole owner/property cascade while preventing
-- an independent referenced expense deletion at commit.
alter table public.work_orders add column completion_expense_id uuid references public.expenses(id) on delete no action deferrable initially deferred;
alter table public.work_orders add column completion_input jsonb;
create unique index if not exists expenses_id_owner_key on public.expenses(id, owner_id);
alter table public.work_orders add constraint work_orders_completion_expense_owner_fk foreign key (completion_expense_id,owner_id) references public.expenses(id,owner_id) on delete no action deferrable initially deferred not valid;
alter table public.maintenance_schedules add column cadence text not null default 'completion' check(cadence in ('completion','scheduled'));
alter table public.maintenance_schedules add column anchor_day integer check(anchor_day between 1 and 31);

create table public.maintenance_completions (
 id uuid primary key default pg_catalog.gen_random_uuid(),owner_id uuid not null references auth.users(id) on delete cascade,
 schedule_id uuid references public.maintenance_schedules(id) on delete set null,
 property_id uuid references public.properties(id) on delete cascade,unit_id uuid references public.units(id) on delete set null,
 asset_id uuid references public.assets(id) on delete set null,completed_on date not null,notes text,next_due date,
 created_at timestamptz not null default now(), unique(schedule_id,completed_on)
);
create index maintenance_completions_owner_idx on public.maintenance_completions(owner_id,schedule_id,completed_on desc);
create table public.inventory_movements (
 id uuid primary key default pg_catalog.gen_random_uuid(),owner_id uuid not null references auth.users(id) on delete cascade,
 inventory_item_id uuid references public.inventory_items(id) on delete set null,
 work_order_id uuid references public.work_orders(id) on delete set null,part_id uuid,
 quantity_change numeric(12,2) not null check(quantity_change<>0 and quantity_change<>'NaN'::numeric),
 reason text not null check(reason in ('used','restored')),created_at timestamptz not null default now()
);
create index inventory_movements_owner_idx on public.inventory_movements(owner_id,inventory_item_id,created_at desc);
create table public.work_order_events (
 id uuid primary key default pg_catalog.gen_random_uuid(),owner_id uuid not null references auth.users(id) on delete cascade,
 work_order_id uuid not null references public.work_orders(id) on delete cascade,
 asset_id uuid references public.assets(id) on delete set null,event_type text not null,
 summary text,data jsonb not null default '{}'::jsonb,created_at timestamptz not null default now()
);
create index work_order_events_owner_idx on public.work_order_events(owner_id,work_order_id,created_at desc);
do $$ declare t text; begin
 foreach t in array array['maintenance_completions','inventory_movements','work_order_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  execute format('create policy owner_read on public.%I for select to authenticated using(owner_id=(select auth.uid()))',t);
 end loop;
end $$;

create or replace function rentview_private.record_work_order_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if tg_op='INSERT' or new.status is distinct from old.status then
  insert into public.work_order_events(owner_id,work_order_id,asset_id,event_type,summary,data)
   values(new.owner_id,new.id,new.asset_id,case when tg_op='INSERT' then 'created' else 'status_changed' end,
     new.title,jsonb_build_object('status',new.status,'actor_id',auth.uid()));
 end if;
 return new;
end;
$$;
create trigger record_work_order_event after insert or update on public.work_orders for each row execute function rentview_private.record_work_order_event();
revoke all on function rentview_private.record_work_order_event() from public,anon,authenticated;

-- Public part writes are constrained operations so every stock change has a
-- matching movement, and a lost acknowledgment cannot consume stock twice.
revoke insert,update,delete on public.work_order_parts from authenticated;
create or replace function public.add_work_order_part(
 p_work_order_id uuid,p_inventory_item_id uuid,p_description text,p_quantity numeric,p_unit_cost numeric,p_currency text,p_operation_id uuid default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare w public.work_orders%rowtype; stock public.inventory_items%rowtype; part public.work_order_parts%rowtype;
 operation_id uuid:=coalesce(p_operation_id,pg_catalog.gen_random_uuid()); actual_cost numeric; actual_currency text; actual_description text;
begin
 if not public.current_account_is_active() then raise exception 'Not authenticated' using errcode='42501'; end if;
 select * into w from public.work_orders where id=p_work_order_id and owner_id=auth.uid() for update;
 if not found then raise exception 'Work order not found' using errcode='42501'; end if;
 if p_quantity is null or p_quantity<=0 or p_quantity in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) then raise exception 'Quantity must be finite and positive' using errcode='23514'; end if;
 -- Stock, parts and movements share numeric(12,2). Reject finer input before
 -- arithmetic so a consume/remove cycle cannot gain stock through rounding.
 if p_quantity<>round(p_quantity,2) then raise exception 'Quantity supports at most two decimal places' using errcode='23514'; end if;
 if p_unit_cost is not null and (p_unit_cost<0 or p_unit_cost in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)) then raise exception 'Cost must be finite and zero or positive' using errcode='23514'; end if;
 if p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'Choose a three-letter currency' using errcode='23514'; end if;
 select * into part from public.work_order_parts where id=operation_id;
 if found then
  if part.owner_id<>auth.uid() or part.work_order_id<>w.id or part.operation_input is distinct from jsonb_build_object('inventory_item_id',p_inventory_item_id,'description',nullif(trim(p_description),''),'quantity',p_quantity,'unit_cost',p_unit_cost,'currency',p_currency) then
    raise exception 'Operation ID was already used for another part' using errcode='23514';
  end if;
  if part.removed_at is not null then raise exception 'Part was already removed. Start a new operation to add it again.' using errcode='23514'; end if;
  return part.id;
 end if;
 if w.status in ('completed','cancelled') or w.completion_expense_id is not null then raise exception 'Parts cannot be changed after a job is completed or cancelled' using errcode='23514'; end if;
 actual_cost:=p_unit_cost; actual_currency:=p_currency; actual_description:=nullif(trim(p_description),'');
 if p_inventory_item_id is not null then
  select * into stock from public.inventory_items where id=p_inventory_item_id and owner_id=auth.uid() for update;
  if not found or (stock.property_id is not null and stock.property_id<>w.property_id) or
    (stock.unit_id is not null and stock.unit_id is distinct from w.unit_id) then
   raise exception 'Inventory item is not available for this location' using errcode='23514';
  end if;
  if stock.quantity<p_quantity then raise exception 'Not enough stock available' using errcode='23514'; end if;
  actual_cost:=stock.unit_cost; actual_currency:=coalesce(stock.cost_currency,p_currency); actual_description:=stock.name;
  update public.inventory_items set quantity=quantity-p_quantity where id=stock.id;
 elsif actual_description is null then raise exception 'Describe the part' using errcode='23514';
 end if;
 insert into public.work_order_parts(id,owner_id,work_order_id,inventory_item_id,description,quantity,unit_cost,cost_currency,operation_input)
  values(operation_id,w.owner_id,w.id,p_inventory_item_id,actual_description,p_quantity,actual_cost,actual_currency,jsonb_build_object('inventory_item_id',p_inventory_item_id,'description',nullif(trim(p_description),''),'quantity',p_quantity,'unit_cost',p_unit_cost,'currency',p_currency)) returning * into part;
 if p_inventory_item_id is not null then
  insert into public.inventory_movements(owner_id,inventory_item_id,work_order_id,part_id,quantity_change,reason)
   values(w.owner_id,p_inventory_item_id,w.id,part.id,-p_quantity,'used');
 end if;
 return part.id;
end;
$$;
create or replace function public.remove_work_order_part(p_part_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare part public.work_order_parts%rowtype; w public.work_orders%rowtype;
begin
 if not public.current_account_is_active() then raise exception 'Not authenticated' using errcode='42501'; end if;
 select * into part from public.work_order_parts where id=p_part_id and owner_id=auth.uid();
 if not found then return; end if;
 select * into w from public.work_orders where id=part.work_order_id and owner_id=auth.uid() for update;
 select * into part from public.work_order_parts where id=p_part_id and owner_id=auth.uid() for update;
 if not found or part.removed_at is not null then return; end if;
 if w.status in ('completed','cancelled') or w.completion_expense_id is not null then raise exception 'Parts cannot be changed after a job is completed or cancelled' using errcode='23514'; end if;
 if part.inventory_item_id is not null then
  update public.inventory_items set quantity=quantity+part.quantity where id=part.inventory_item_id and owner_id=auth.uid();
  insert into public.inventory_movements(owner_id,inventory_item_id,work_order_id,part_id,quantity_change,reason)
   values(part.owner_id,part.inventory_item_id,part.work_order_id,part.id,part.quantity,'restored');
 end if;
 update public.work_order_parts set removed_at=now() where id=part.id;
end;
$$;
create or replace function public.complete_work_order(p_work_order_id uuid,p_labor_amount numeric,p_currency text,p_summary text default null,p_use_existing_expenses boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare w public.work_orders%rowtype; parts_total numeric; expense_id uuid; invoice_total numeric;
begin
 if not public.current_account_is_active() then raise exception 'Not authenticated' using errcode='42501'; end if;
 -- Direct invoice writes and completion share one transaction lock. Take it
 -- before the job row so invoice-row triggers can fail retryably instead of
 -- deadlocking against a completion that references the same invoice.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('work-order-cost:'||p_work_order_id::text,613));
 select * into w from public.work_orders where id=p_work_order_id and owner_id=auth.uid() for update;
 if not found then raise exception 'Work order not found' using errcode='42501'; end if;
 if exists(select 1 from public.expenses e where e.work_order_id=w.id and (e.owner_id<>w.owner_id or e.property_id is distinct from w.property_id))
    or exists(select 1 from public.work_order_parts p where p.work_order_id=w.id and p.owner_id<>w.owner_id) then
  raise exception 'Legacy repair links are inconsistent; reconcile them before posting costs' using errcode='23514';
 end if;
 if w.completion_expense_id is not null then
  if w.completion_input is distinct from jsonb_build_object('labor',p_labor_amount,'currency',p_currency,'summary',nullif(trim(p_summary),''),'use_existing',p_use_existing_expenses) then
   raise exception 'This job already has posted costs; use a separate correction instead of changing a retry' using errcode='23514';
  end if;
  return w.completion_expense_id;
 end if;
 if length(coalesce(p_summary,''))>10000 then raise exception 'Completion summary is too long' using errcode='23514'; end if;
 if w.status='cancelled' then raise exception 'A cancelled job cannot be completed' using errcode='23514'; end if;
 if p_labor_amount is null or p_labor_amount<0 or p_labor_amount in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) then raise exception 'Labor cost must be finite and zero or positive' using errcode='23514'; end if;
 if p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'Choose a three-letter currency' using errcode='23514'; end if;
 if p_use_existing_expenses then
  if p_labor_amount<>0 then raise exception 'Existing invoices already cover this repair; do not add labor again' using errcode='23514'; end if;
  if exists(select 1 from public.expenses e where e.work_order_id=w.id and e.owner_id=w.owner_id and e.currency<>p_currency) then raise exception 'Existing invoices must use the selected currency' using errcode='23514'; end if;
  select id into expense_id from public.expenses where work_order_id=w.id and owner_id=w.owner_id order by incurred_on,id limit 1;
  if not found then raise exception 'There are no linked invoices to use' using errcode='23514'; end if;
  select sum(amount) into invoice_total from public.expenses where work_order_id=w.id and owner_id=w.owner_id;
  update public.work_orders set status='completed',completed_at=now(),cost=invoice_total,cost_currency=p_currency,completion_expense_id=expense_id,completion_input=jsonb_build_object('labor',p_labor_amount,'currency',p_currency,'summary',nullif(trim(p_summary),''),'use_existing',p_use_existing_expenses) where id=w.id;
  insert into public.work_order_events(owner_id,work_order_id,asset_id,event_type,summary,data)
   values(w.owner_id,w.id,w.asset_id,'cost_posted',nullif(trim(p_summary),''),jsonb_build_object('source','existing_expenses','total',invoice_total,'currency',p_currency));
  return expense_id;
 end if;
 if exists(select 1 from public.expenses e where e.work_order_id=w.id and e.owner_id=w.owner_id) then raise exception 'Use existing invoices to avoid posting this repair twice' using errcode='23514'; end if;
 if exists(select 1 from public.work_order_parts p where p.work_order_id=w.id and p.owner_id=w.owner_id and p.removed_at is null and p.unit_cost is not null and p.cost_currency is distinct from p_currency) then
  raise exception 'All priced parts and labor must use the same currency before completion' using errcode='23514';
 end if;
 select coalesce(sum(quantity*coalesce(unit_cost,0)),0) into parts_total from public.work_order_parts where work_order_id=w.id and owner_id=w.owner_id and removed_at is null;
 insert into public.expenses(owner_id,property_id,unit_id,work_order_id,vendor_id,category,description,amount,currency,incurred_on)
  values(w.owner_id,w.property_id,w.unit_id,w.id,w.vendor_id,'repair',coalesce(nullif(trim(p_summary),''),w.title),parts_total+p_labor_amount,p_currency,current_date)
  returning id into expense_id;
 update public.work_orders set status='completed',completed_at=now(),cost=parts_total+p_labor_amount,cost_currency=p_currency,completion_expense_id=expense_id,completion_input=jsonb_build_object('labor',p_labor_amount,'currency',p_currency,'summary',nullif(trim(p_summary),''),'use_existing',p_use_existing_expenses) where id=w.id;
 insert into public.work_order_events(owner_id,work_order_id,asset_id,event_type,summary,data)
  values(w.owner_id,w.id,w.asset_id,'cost_posted',nullif(trim(p_summary),''),jsonb_build_object('expense_id',expense_id,'labor',p_labor_amount,'parts',parts_total,'currency',p_currency));
 return expense_id;
end;
$$;
revoke all on function public.add_work_order_part(uuid,uuid,text,numeric,numeric,text,uuid),public.remove_work_order_part(uuid),public.complete_work_order(uuid,numeric,text,text,boolean) from public,anon;
grant execute on function public.add_work_order_part(uuid,uuid,text,numeric,numeric,text,uuid),public.remove_work_order_part(uuid),public.complete_work_order(uuid,numeric,text,text,boolean) to authenticated;

create or replace function rentview_private.guard_posted_work()
returns trigger language plpgsql set search_path = '' as $$
declare affected_jobs uuid[]; related_job uuid;
begin
 if tg_table_name='work_orders' then
  if tg_op='INSERT' and current_user in ('authenticated','anon') and (new.status='completed' or new.completion_expense_id is not null or new.completion_input is not null) then
   raise exception 'Create an open job, then use the completion action to post its costs' using errcode='42501';
  end if;
  if tg_op='DELETE' and current_user in ('authenticated','anon') and (old.completion_expense_id is not null or exists(select 1 from public.work_order_parts p where p.work_order_id=old.id and p.removed_at is null and p.inventory_item_id is not null)) then
   raise exception 'Keep completed history; remove stock parts before deleting an uncompleted job' using errcode='23514';
  end if;
  if tg_op='UPDATE' and current_user in ('authenticated','anon') then
   if new.completion_expense_id is distinct from old.completion_expense_id or new.completion_input is distinct from old.completion_input or
      (old.completion_expense_id is not null and (new.status is distinct from old.status or new.cost is distinct from old.cost or new.cost_currency is distinct from old.cost_currency or new.completed_at is distinct from old.completed_at)) or
      (new.status='completed' and old.status<>'completed') then
    raise exception 'Use the completion action to record a job and its costs together' using errcode='42501';
   end if;
  end if;
 elsif current_user in ('authenticated','anon') then
  if tg_op='INSERT' then affected_jobs:=array[new.work_order_id];
  elsif tg_op='DELETE' then affected_jobs:=array[old.work_order_id];
  else affected_jobs:=array[old.work_order_id,new.work_order_id]; end if;
  for related_job in select distinct j.id from unnest(affected_jobs) j(id) where j.id is not null order by j.id loop
   -- UPDATE/DELETE already hold the expense row before this trigger. Never
   -- wait while holding it: completion may need a foreign-key lock on it.
   if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('work-order-cost:'||related_job::text,613)) then
    raise exception 'Repair costs are being updated. Retry this change shortly.' using errcode='40001';
   end if;
  end loop;
  if tg_op in ('INSERT','UPDATE') and exists(select 1 from public.work_orders w where w.id=new.work_order_id and w.completion_expense_id is not null) then
   raise exception 'A completed job cannot receive independent expense changes' using errcode='23514';
  elsif tg_op<>'INSERT' and exists(select 1 from public.work_orders w where w.id=old.work_order_id and w.completion_expense_id is not null) then
   raise exception 'A posted completion expense cannot be changed independently of its job' using errcode='23514';
  end if;
 end if;
 if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
create trigger guard_posted_work before insert or update or delete on public.work_orders for each row execute function rentview_private.guard_posted_work();
create trigger guard_posted_expense before insert or update or delete on public.expenses for each row execute function rentview_private.guard_posted_work();
revoke all on function rentview_private.guard_posted_work() from public,anon,authenticated;

create or replace function public.asset_cost_totals(p_asset_id uuid)
returns table(currency text,total numeric) language sql stable security invoker set search_path = '' as $$
 select e.currency,sum(e.amount) from public.expenses e join public.work_orders w on w.id=e.work_order_id and w.owner_id=e.owner_id
 where w.asset_id=p_asset_id and e.owner_id=(select auth.uid()) group by e.currency order by e.currency;
$$;
revoke all on function public.asset_cost_totals(uuid) from public,anon;
grant execute on function public.asset_cost_totals(uuid) to authenticated;

create or replace function rentview_private.next_maintenance_date(p_base date,p_completed date,p_frequency public.schedule_freq,p_interval integer,p_anchor integer)
returns date language plpgsql immutable set search_path = '' as $$
declare months_step integer; day_step integer; jumps integer; target_month date; candidate date;
begin
 months_step:=case p_frequency when 'monthly' then 1 when 'quarterly' then 3 when 'biannual' then 6 when 'annual' then 12 else null end;
 if months_step is not null then
  jumps:=greatest(1,((extract(year from p_completed)::int-extract(year from p_base)::int)*12+extract(month from p_completed)::int-extract(month from p_base)::int)/months_step);
  target_month:=(date_trunc('month',p_base)::date+make_interval(months=>months_step*jumps))::date;
  candidate:=target_month+(least(p_anchor,extract(day from (target_month+interval '1 month - 1 day'))::int)-1);
  if candidate<=p_completed then
   target_month:=(target_month+make_interval(months=>months_step))::date;
   candidate:=target_month+(least(p_anchor,extract(day from (target_month+interval '1 month - 1 day'))::int)-1);
  end if;
  return candidate;
 end if;
 day_step:=case p_frequency when 'daily' then 1 when 'weekly' then 7 when 'custom' then p_interval else null end;
 if day_step is null or day_step<1 or day_step>36500 then raise exception 'Invalid maintenance interval' using errcode='23514'; end if;
 return p_base+day_step*greatest(1,(p_completed-p_base)/day_step+1);
end;
$$;
revoke all on function rentview_private.next_maintenance_date(date,date,public.schedule_freq,integer,integer) from public,anon,authenticated;

create or replace function public.complete_maintenance_schedule(p_schedule_id uuid,p_completed_on date default current_date,p_notes text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare s public.maintenance_schedules%rowtype; completion_id uuid; base_date date; due_date date; anchor integer;
begin
 if not public.current_account_is_active() then raise exception 'Not authenticated' using errcode='42501'; end if;
 select * into s from public.maintenance_schedules where id=p_schedule_id and owner_id=auth.uid() for update;
 if not found then raise exception 'Schedule not found' using errcode='42501'; end if;
 select id into completion_id from public.maintenance_completions where schedule_id=s.id and completed_on=p_completed_on;
 if found then return completion_id; end if;
 if not s.is_active then raise exception 'Resume this schedule before completing it' using errcode='23514'; end if;
 if p_completed_on is null or p_completed_on>current_date or (s.last_done is not null and p_completed_on<s.last_done) then raise exception 'Choose a valid completion date, not before the previous completion' using errcode='23514'; end if;
 if length(coalesce(p_notes,''))>10000 then raise exception 'Completion note is too long' using errcode='23514'; end if;
 base_date:=case when s.cadence='scheduled' then coalesce(s.next_due,p_completed_on) else p_completed_on end;
 anchor:=case when s.cadence='scheduled' then coalesce(s.anchor_day,extract(day from base_date)::int) else extract(day from p_completed_on)::int end;
 due_date:=rentview_private.next_maintenance_date(base_date,p_completed_on,s.frequency,s.interval_days,anchor);
 insert into public.maintenance_completions(owner_id,schedule_id,property_id,unit_id,asset_id,completed_on,notes,next_due)
  values(s.owner_id,s.id,s.property_id,s.unit_id,s.asset_id,p_completed_on,nullif(trim(p_notes),''),due_date) returning id into completion_id;
 update public.maintenance_schedules set last_done=p_completed_on,next_due=due_date,anchor_day=case when s.cadence='scheduled' then anchor else null end where id=s.id;
 return completion_id;
end;
$$;
revoke all on function public.complete_maintenance_schedule(uuid,date,text) from public,anon;
grant execute on function public.complete_maintenance_schedule(uuid,date,text) to authenticated;

-- New operational histories and trigger helpers are not exposed as generic
-- writes. Privileged operations above validate the actor before changing rows.
notify pgrst, 'reload schema';

-- Reasonable per-principal limits bound notification/storage amplification.
-- Creation times are assigned here so a client cannot evade the rolling window
-- by supplying a past timestamp. Advisory locks serialize concurrent attempts.
alter table public.request_photos add column uploaded_by uuid references auth.users(id) on delete set null default auth.uid();
create index request_photos_uploader_created_idx on public.request_photos(uploaded_by,created_at desc);
create index request_messages_sender_created_idx on public.request_messages(sender_id,created_at desc);
create index maintenance_requests_tenant_created_idx on public.maintenance_requests(tenant_user_id,created_at desc);
create or replace function rentview_private.limit_portal_writes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare uid uuid:=auth.uid(); n integer;
begin
 if uid is null then return new; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text||tg_table_name,612));
 new.created_at:=now();
 if tg_table_name='maintenance_requests' then
  if exists(select 1 from public.maintenance_requests where id=new.id and tenant_user_id=uid) then return new; end if;
  select count(*) into n from public.maintenance_requests where tenant_user_id=uid and created_at>now()-interval '1 minute';
  if n>=10 then raise exception 'Too many requests. Wait a minute and try again.' using errcode='P0001'; end if;
 elsif tg_table_name='request_messages' then
  if exists(select 1 from public.request_messages where id=new.id and sender_id=uid) then return new; end if;
  select count(*) into n from public.request_messages where sender_id=uid and created_at>now()-interval '1 minute';
  if n>=30 then raise exception 'Too many messages. Wait a minute and try again.' using errcode='P0001'; end if;
 elsif tg_table_name='request_photos' then
  new.uploaded_by:=uid;
  if exists(select 1 from public.request_photos where id=new.id and uploaded_by=uid) then return new; end if;
  select count(*) into n from public.request_photos where uploaded_by=uid and created_at>now()-interval '1 minute';
  if n>=20 then raise exception 'Too many photos. Wait a minute and try again.' using errcode='P0001'; end if;
 end if;
 return new;
end;
$$;
revoke all on function rentview_private.limit_portal_writes() from public,anon,authenticated;
create trigger limit_portal_writes before insert on public.maintenance_requests for each row execute function rentview_private.limit_portal_writes();
create trigger limit_portal_writes before insert on public.request_messages for each row execute function rentview_private.limit_portal_writes();
create trigger limit_portal_writes before insert on public.request_photos for each row execute function rentview_private.limit_portal_writes();

create or replace function public.register_push_token(p_token text,p_platform text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid:=auth.uid();
begin
 if uid is null or not public.current_account_is_active() then raise exception 'Not authenticated' using errcode='42501'; end if;
 if p_token is null or trim(p_token) !~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$' then raise exception 'Invalid Expo push token' using errcode='23514'; end if;
 if p_platform is not null and p_platform not in ('ios','android','web') then raise exception 'Invalid platform' using errcode='23514'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text||'push_tokens',612));
 if (select count(*) from public.push_tokens where user_id=uid and token<>trim(p_token))>=20 then raise exception 'Device limit reached. Remove an old device first.' using errcode='23514'; end if;
 insert into public.push_tokens(user_id,token,platform) values(uid,trim(p_token),p_platform)
 on conflict(token) do update set user_id=uid,platform=coalesce(excluded.platform,push_tokens.platform),updated_at=now();
end;
$$;
revoke all on function public.register_push_token(text,text) from public,anon;
grant execute on function public.register_push_token(text,text) to authenticated;
notify pgrst, 'reload schema';

-- Defensive reads also reject inconsistent legacy relationships while the
-- NOT VALID constraints await explicit administrative reconciliation.
drop policy owner_select_requests on public.maintenance_requests;
drop policy owner_update_requests on public.maintenance_requests;
drop policy owner_delete_requests on public.maintenance_requests;
create policy owner_select_requests on public.maintenance_requests for select to authenticated using(owner_id=(select auth.uid()) and public.can_access_request(id));
create policy owner_update_requests on public.maintenance_requests for update to authenticated using(owner_id=(select auth.uid()) and public.can_access_request(id)) with check(owner_id=(select auth.uid()) and public.can_access_request(id));
create policy owner_delete_requests on public.maintenance_requests for delete to authenticated using(owner_id=(select auth.uid()) and public.can_access_request(id));
drop policy tenant_select_rent_payments on public.rent_payments;
create policy tenant_select_rent_payments on public.rent_payments for select to authenticated using(
 exists(select 1 from public.tenant_lease_details d where d.lease_id=rent_payments.lease_id and d.owner_id=rent_payments.owner_id));
alter table public.maintenance_requests add constraint request_description_bounded check(length(coalesce(description,''))<=8000) not valid;
alter table public.request_photos add constraint request_photo_path_bounded check(length(storage_path)<=1024) not valid;
notify pgrst, 'reload schema';

-- Occupancy follows recorded active leases, while explicit maintenance and
-- unavailable flags remain under owner control. Multiple occupants are allowed.
create or replace function rentview_private.sync_unit_occupancy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target_unit uuid;
begin
 target_unit:=case when tg_op='DELETE' then old.unit_id else new.unit_id end;
 update public.units u set status=case when exists(select 1 from public.leases l where l.unit_id=u.id and l.owner_id=u.owner_id and l.status='active')
   then 'occupied'::public.unit_status else 'vacant'::public.unit_status end
 where u.id=target_unit and u.status in ('vacant','occupied');
 if tg_op='UPDATE' and old.unit_id is distinct from new.unit_id then
  update public.units u set status=case when exists(select 1 from public.leases l where l.unit_id=u.id and l.owner_id=u.owner_id and l.status='active')
   then 'occupied'::public.unit_status else 'vacant'::public.unit_status end
  where u.id=old.unit_id and u.status in ('vacant','occupied');
 end if;
 if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
create trigger sync_unit_occupancy after insert or update or delete on public.leases for each row execute function rentview_private.sync_unit_occupancy();
revoke all on function rentview_private.sync_unit_occupancy() from public,anon,authenticated;
notify pgrst, 'reload schema';

-- Status mirroring must not traverse inconsistent pre-hardening links while
-- NOT VALID constraints await administrative reconciliation.
create or replace function public.sync_request_from_work_order()
returns trigger language plpgsql set search_path='' as $$
begin
 if new.status is distinct from old.status then
  update public.maintenance_requests r set
   status=case new.status when 'open' then 'acknowledged'::public.request_status
     when 'in_progress' then 'in_progress'::public.request_status
     when 'on_hold' then 'acknowledged'::public.request_status
     when 'completed' then 'resolved'::public.request_status
     when 'cancelled' then 'closed'::public.request_status end,
   resolved_at=case when new.status='completed' then now() else r.resolved_at end
  where r.work_order_id=new.id and r.owner_id=new.owner_id
    and r.property_id=new.property_id and r.unit_id is not distinct from new.unit_id
    and r.status not in ('resolved','closed')
    and exists(select 1 from public.leases l join public.units u on u.id=l.unit_id and u.owner_id=l.owner_id
      where l.id=r.lease_id and l.owner_id=r.owner_id and l.unit_id=r.unit_id and u.property_id=r.property_id);
 end if;
 return new;
end;
$$;
revoke all on function public.sync_request_from_work_order() from public,anon,authenticated;


-- Backend services and identity lifecycle follow the ownership foundation.
-- Backend-only reliability boundaries. All public entry points are service-role-only.
create schema if not exists rentview_private;
-- Authenticated schema USAGE supports the scoped invoker-view projection.
-- It grants no execution on the other private helpers, revoked individually.
revoke all on schema rentview_private from public, anon;

alter table public.subscriptions add column if not exists billing_verified_at timestamptz;
-- Legacy rows were client-writable: only validated provider updates establish provenance.
alter table public.billing_events add column if not exists occurred_at timestamptz;
alter table public.billing_events add column if not exists processing_state text not null default 'pending'
  check (processing_state in ('pending','applied','stale','unmatched','superseded'));
alter table public.billing_events add column if not exists processed_at timestamptz;

create table public.billing_subscription_states (
  provider public.sub_provider not null,
  subscription_id text not null,
  owner_id uuid references auth.users(id) on delete set null,
  customer_id text,
  plan public.plan_tier not null,
  status public.sub_status not null,
  period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  event_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  primary key (provider, subscription_id),
  check (length(subscription_id) between 1 and 200)
);
create index on public.billing_subscription_states(owner_id);
alter table public.billing_subscription_states enable row level security;
revoke all on public.billing_subscription_states from public,anon,authenticated;
grant all on public.billing_subscription_states to service_role;
-- Backfill only independently verified operator evidence, never the newly
-- added NULL column or client-supplied provider IDs. Rejected claims retain their
-- original values solely in the private audit snapshot and receive Free access.
do $$ begin
 if to_regclass('rentview_private.legacy_billing_reconciliation') is not null then
  insert into public.billing_subscription_states(provider,subscription_id,owner_id,customer_id,plan,status,period_end,cancel_at_period_end,event_at,first_seen_at)
  select r.provider,r.subscription_id,r.owner_id,r.customer_id,r.plan,r.status,r.period_end,r.cancel_at_period_end,r.provider_updated_at,r.verified_at
  from rentview_private.legacy_billing_reconciliation r join public.subscriptions s on s.owner_id=r.owner_id
  where r.decision='verified' and r.legacy_snapshot=to_jsonb(s)-'billing_verified_at'
  on conflict(provider,subscription_id) do nothing;
  update public.subscriptions s set provider=r.provider,provider_subscription_id=r.subscription_id,
    provider_customer_id=r.customer_id,plan=r.plan,status=r.status,current_period_end=r.period_end,
    cancel_at_period_end=r.cancel_at_period_end,billing_verified_at=r.verified_at
  from rentview_private.legacy_billing_reconciliation r where r.owner_id=s.owner_id and r.decision='verified' and r.legacy_snapshot=to_jsonb(s)-'billing_verified_at';
  update public.subscriptions s set provider_subscription_id=null,provider_customer_id=null,
    plan='free',status='expired',current_period_end=null,cancel_at_period_end=false
  from rentview_private.legacy_billing_reconciliation r where r.owner_id=s.owner_id and r.decision='rejected' and r.legacy_snapshot=to_jsonb(s)-'billing_verified_at';
 end if;
end $$;

create or replace function public.apply_billing_event(
  p_provider text,p_event_id text,p_event_type text,p_owner_id uuid,p_subscription_id text,
  p_customer_id text,p_plan text,p_status text,p_period_end timestamptz,
  p_cancel_at_period_end boolean,p_occurred_at timestamptz,p_payload jsonb
) returns text language plpgsql security definer set search_path = '' as $$
declare
  prior public.billing_subscription_states%rowtype;
  saved public.billing_events%rowtype;
  resolved_owner uuid;
  result_state text := 'applied';
begin
  if p_provider not in ('lemonsqueezy','paypal') or p_plan not in ('free','pro')
     or p_status not in ('trialing','active','past_due','cancelled','expired')
     or coalesce(length(p_event_id),0) not between 1 and 500
     or coalesce(length(p_event_type),0) not between 1 and 200
     or coalesce(length(p_subscription_id),0) not between 1 and 200
     or p_occurred_at is null or p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or p_occurred_at > now() + interval '5 minutes' then
    raise exception 'Invalid billing event' using errcode='22023';
  end if;
  -- Use owner -> subscription -> row order everywhere. Identity deletion
  -- takes the owner lock before FK cascades; taking a subscription row first
  -- would invert the order and deadlock a concurrent provider delivery.
  select * into prior from public.billing_subscription_states
    where provider=p_provider::public.sub_provider and subscription_id=p_subscription_id;
  -- Checkout custom_data/custom_id is customer-controlled input. It can
  -- corroborate an existing service-owned binding, never establish one.
  resolved_owner := prior.owner_id;
  if prior.owner_id is not null and p_owner_id is not null and prior.owner_id <> p_owner_id then
    raise exception 'Subscription account binding cannot change' using errcode='22023';
  end if;
  if resolved_owner is not null then
    perform pg_advisory_xact_lock(hashtextextended('billing-owner:'||resolved_owner::text,0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('billing-sub:'||p_provider||':'||p_subscription_id,0));
  select * into prior from public.billing_subscription_states
    where provider=p_provider::public.sub_provider and subscription_id=p_subscription_id for update;
  if prior.owner_id is not null and resolved_owner is distinct from prior.owner_id then
    if p_owner_id is not null then
      raise exception 'Subscription account binding cannot change' using errcode='22023';
    end if;
    raise exception 'Subscription binding changed concurrently; retry this delivery' using errcode='40001';
  end if;
  if resolved_owner is not null and not exists(select 1 from auth.users where id=resolved_owner) then
    resolved_owner := null;
  end if;
  select * into saved from public.billing_events
    where provider=p_provider::public.sub_provider and event_id=p_event_id for update;
  if found and saved.processing_state not in ('pending','unmatched') then return 'duplicate'; end if;
  insert into public.billing_events(provider,event_id,event_type,owner_id,payload,occurred_at,processing_state)
  values(p_provider::public.sub_provider,p_event_id,p_event_type,resolved_owner,p_payload,p_occurred_at,'pending')
  on conflict(provider,event_id) do update set owner_id=excluded.owner_id,payload=excluded.payload,occurred_at=excluded.occurred_at;
  if resolved_owner is null then
    update public.billing_events set processing_state='unmatched',processed_at=null
    where provider=p_provider::public.sub_provider and event_id=p_event_id;
    return 'unmatched';
  end if;
  if prior.event_at is not null and p_occurred_at <= prior.event_at then
    result_state := 'stale';
  else
    insert into public.billing_subscription_states(provider,subscription_id,owner_id,customer_id,plan,status,period_end,cancel_at_period_end,event_at)
    values(p_provider::public.sub_provider,p_subscription_id,resolved_owner,p_customer_id,p_plan::public.plan_tier,p_status::public.sub_status,p_period_end,coalesce(p_cancel_at_period_end,false),p_occurred_at)
    on conflict(provider,subscription_id) do update set owner_id=excluded.owner_id,customer_id=excluded.customer_id,
      plan=excluded.plan,status=excluded.status,period_end=excluded.period_end,cancel_at_period_end=excluded.cancel_at_period_end,event_at=excluded.event_at;
    -- Project access from ALL subscriptions. Cancelling an old provider cannot remove
    -- entitlement still granted by another paid subscription.
    insert into public.subscriptions(owner_id,provider,provider_subscription_id,provider_customer_id,plan,status,current_period_end,cancel_at_period_end,billing_verified_at)
    select resolved_owner,s.provider,s.subscription_id,s.customer_id,s.plan,s.status,s.period_end,s.cancel_at_period_end,now()
    from public.billing_subscription_states s where s.owner_id=resolved_owner
    order by (s.plan='pro' and (s.status in ('active','trialing','past_due') or (s.status='cancelled' and s.period_end>now()))) desc,
      (s.status in ('active','trialing','past_due')) desc,s.first_seen_at desc,s.event_at desc,s.subscription_id
    limit 1
    on conflict(owner_id) do update set provider=excluded.provider,provider_subscription_id=excluded.provider_subscription_id,
      provider_customer_id=excluded.provider_customer_id,plan=excluded.plan,status=excluded.status,
      current_period_end=excluded.current_period_end,cancel_at_period_end=excluded.cancel_at_period_end,billing_verified_at=excluded.billing_verified_at;
  end if;
  update public.billing_events set processing_state=result_state,processed_at=now()
    where provider=p_provider::public.sub_provider and event_id=p_event_id;
  return result_state;
end; $$;
revoke all on function public.apply_billing_event(text,text,text,uuid,text,text,text,text,timestamptz,boolean,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.apply_billing_event(text,text,text,uuid,text,text,text,text,timestamptz,boolean,timestamptz,jsonb) to service_role;

alter table public.notification_prefs add column if not exists email_enabled boolean not null default true;
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  event text not null check(event in ('request_created','request_updated','request_message','announcement')),
  row_id uuid not null,
  actor_id uuid,
  preview text,
  status text not null default 'pending' check(status in ('pending','processing','sent','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  claim_token uuid,
  last_error text,
  deliveries jsonb not null default '{}'::jsonb,
  receipt_pending boolean not null default false,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index on public.notification_outbox(status,next_attempt_at);
create index notification_receipt_pending_idx on public.notification_outbox(created_at,id) where receipt_pending;
alter table public.notification_outbox enable row level security;
revoke all on public.notification_outbox from public,anon,authenticated;
grant all on public.notification_outbox to service_role;
create or replace function public.claim_notification_batch(p_limit integer default 5,p_id uuid default null)
returns setof public.notification_outbox language plpgsql security definer set search_path = '' as $$
begin
  -- A worker can die on its final claim. Preserve the exhausted record as
  -- failed instead of leaving it processing forever outside the claim filter.
  update public.notification_outbox set status='failed',locked_at=null,claim_token=null,
    last_error=coalesce(last_error,'Delivery worker did not finish before the retry limit')
    where attempts>=8 and status='processing' and locked_at<now()-interval '10 minutes';
  return query with picked as (
    select n.id from public.notification_outbox n
    where (p_id is null or n.id=p_id) and n.attempts<8
      and ((n.status='pending' and n.next_attempt_at<=now()) or (n.status='processing' and n.locked_at<now()-interval '10 minutes'))
    order by n.next_attempt_at,n.id for update skip locked limit greatest(1,least(coalesce(p_limit,5),20))
  ) update public.notification_outbox n set status='processing',attempts=n.attempts+1,locked_at=now(),claim_token=gen_random_uuid()
    from picked where n.id=picked.id returning n.*;
end;
$$;
revoke all on function public.claim_notification_batch(integer,uuid) from public,anon,authenticated;
grant execute on function public.claim_notification_batch(integer,uuid) to service_role;
create or replace function public.finish_notification(p_id uuid,p_claim_token uuid,p_success boolean,p_deliveries jsonb,p_error text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.notification_outbox set
    status=case when p_success then 'sent' when attempts>=8 then 'failed' else 'pending' end,
    deliveries=coalesce(p_deliveries,'{}'::jsonb),
    receipt_pending=p_success and exists(select 1 from jsonb_each(coalesce(p_deliveries,'{}'::jsonb)) d where d.value->>'channel'='push' and d.value->>'status'='accepted'),
    last_error=left(p_error,500),locked_at=null,claim_token=null,
    completed_at=case when p_success then now() else null end,
    next_attempt_at=now()+make_interval(secs=>least(3600,power(2,least(attempts,8))::integer*30))
    where id=p_id and status='processing' and claim_token=p_claim_token;
  return found;
end; $$;
revoke all on function public.finish_notification(uuid,uuid,boolean,jsonb,text) from public,anon,authenticated;
grant execute on function public.finish_notification(uuid,uuid,boolean,jsonb,text) to service_role;

create or replace function public.notify_push(p_event text,p_id uuid,p_actor uuid,p_preview text default null)
returns void language plpgsql security definer set search_path='' as $$
declare notification_id uuid; cfg record;
begin
  insert into public.notification_outbox(event,row_id,actor_id,preview)
  values(p_event,p_id,p_actor,left(p_preview,140)) returning id into notification_id;
  select * into cfg from public.push_hook_config();
  if cfg.hook_url is not null and cfg.hook_secret is not null then
    begin
      perform net.http_post(url:=cfg.hook_url,headers:=jsonb_build_object('Content-Type','application/json','x-push-secret',cfg.hook_secret),body:=jsonb_build_object('outbox_id',notification_id));
    exception when others then
      -- The durable row survives a transport failure and the worker retries it.
      raise warning 'Notification dispatch deferred';
    end;
  end if;
end; $$;
revoke all on function public.notify_push(text,uuid,uuid,text) from public,anon,authenticated;

create table public.reminder_deliveries (
  id uuid primary key default gen_random_uuid(),owner_id uuid not null references auth.users(id) on delete cascade,
  reminder_day date not null,status text not null default 'processing' check(status in ('processing','sent','failed')),
  attempts integer not null default 1,locked_at timestamptz,claim_token uuid,provider_id text,last_error text,
  next_attempt_at timestamptz not null default now(),sent_at timestamptz,
  unique(owner_id,reminder_day)
);
alter table public.reminder_deliveries enable row level security;
revoke all on public.reminder_deliveries from public,anon,authenticated;
grant all on public.reminder_deliveries to service_role;
create or replace function public.claim_reminder(p_owner_id uuid,p_day date)
returns public.reminder_deliveries language plpgsql security definer set search_path='' as $$
declare item public.reminder_deliveries%rowtype;
begin
  update public.reminder_deliveries set status='failed',locked_at=null,claim_token=null,
    last_error=coalesce(last_error,'Reminder worker did not finish before the retry limit')
    where owner_id=p_owner_id and reminder_day=p_day and attempts>=8 and status='processing' and locked_at<now()-interval '10 minutes';
  insert into public.reminder_deliveries(owner_id,reminder_day,locked_at,claim_token)
    values(p_owner_id,p_day,now(),gen_random_uuid()) on conflict do nothing;
  if found then select * into item from public.reminder_deliveries where owner_id=p_owner_id and reminder_day=p_day; return item; end if;
  update public.reminder_deliveries set status='processing',attempts=attempts+1,locked_at=now(),claim_token=gen_random_uuid()
    where owner_id=p_owner_id and reminder_day=p_day and attempts<8
      and ((status='failed' and next_attempt_at<=now()) or (status='processing' and locked_at<now()-interval '10 minutes')) returning * into item;
  return item;
end; $$;
revoke all on function public.claim_reminder(uuid,date) from public,anon,authenticated;
grant execute on function public.claim_reminder(uuid,date) to service_role;
create or replace function public.finish_reminder(p_id uuid,p_claim_token uuid,p_success boolean,p_provider_id text default null,p_error text default null)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.reminder_deliveries set status=case when p_success then 'sent' else 'failed' end,
    provider_id=p_provider_id,last_error=left(p_error,500),locked_at=null,claim_token=null,
    sent_at=case when p_success then now() else null end,next_attempt_at=now()+interval '15 minutes'
    where id=p_id and claim_token=p_claim_token and status='processing';
  return found;
end; $$;
revoke all on function public.finish_reminder(uuid,uuid,boolean,text,text) from public,anon,authenticated;
grant execute on function public.finish_reminder(uuid,uuid,boolean,text,text) to service_role;
create or replace function public.due_reminder_owners(p_today date,p_soon date,p_limit integer default 25)
returns table(owner_id uuid) language plpgsql security definer set search_path='' as $$
begin
  update public.reminder_deliveries r set status='failed',locked_at=null,claim_token=null,
    last_error=coalesce(r.last_error,'Reminder worker did not finish before the retry limit')
    where r.attempts>=8 and r.status='processing' and r.locked_at<now()-interval '10 minutes';
  return query with owners as (
    select a.owner_id from public.assets a where a.warranty_expiry between p_today and p_soon
    union select m.owner_id from public.maintenance_schedules m where m.is_active and m.next_due<=p_today
  ) select o.owner_id from owners o left join public.reminder_deliveries r on r.owner_id=o.owner_id and r.reminder_day=p_today
    where r.id is null or (r.status='failed' and r.attempts<8 and r.next_attempt_at<=now())
      or (r.status='processing' and r.attempts<8 and r.locked_at<now()-interval '10 minutes')
    order by o.owner_id limit greatest(1,least(coalesce(p_limit,25),100));
end;
$$;
revoke all on function public.due_reminder_owners(date,date,integer) from public,anon,authenticated;
grant execute on function public.due_reminder_owners(date,date,integer) to service_role;

create table public.account_deletion_requests (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  started_at timestamptz not null default now()
);
alter table public.account_deletion_requests enable row level security;
revoke all on public.account_deletion_requests from public,anon,authenticated;
grant all on public.account_deletion_requests to service_role;
create or replace function public.current_account_is_active()
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from auth.users u where u.id=(select auth.uid()))
    and not exists(select 1 from public.account_deletion_requests d where d.owner_id=(select auth.uid()));
$$;
revoke all on function public.current_account_is_active() from public,anon;
grant execute on function public.current_account_is_active() to authenticated,service_role;
-- Restrictive policies cannot grant access; they constrain existing owner and
-- participant policies, including direct reads during deletion cleanup.
do $$ declare t text; begin
 for t in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity loop
   execute format('create policy current_account_required on public.%I as restrictive for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active())',t);
 end loop;
end $$;
create policy current_account_required on storage.objects as restrictive for all to authenticated
 using(public.current_account_is_active()) with check(public.current_account_is_active());

create or replace function public.prepare_identity_deletion(p_owner_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('billing-owner:'||p_owner_id::text,0));
  if exists(select 1 from public.billing_subscription_states where owner_id=p_owner_id and status in ('active','trialing','past_due') and not cancel_at_period_end)
    or exists(select 1 from public.subscriptions where owner_id=p_owner_id and status in ('active','trialing','past_due') and not cancel_at_period_end and provider_subscription_id is not null and billing_verified_at is not null) then
    raise exception 'Cancel your subscription before deleting this account so billing cannot continue.' using errcode='P0001';
  end if;
  insert into public.account_deletion_requests(owner_id) values(p_owner_id) on conflict do nothing;
end; $$;
revoke all on function public.prepare_identity_deletion(uuid) from public,anon,authenticated;
grant execute on function public.prepare_identity_deletion(uuid) to service_role;
-- The final identity delete shares billing's owner lock. An activation received
-- during Storage cleanup is recorded factually, and prevents deletion until it
-- is cancelled. Provider events arriving after deletion remain unmatched rather
-- than recreating a user; external checkout lifecycle still needs reconciliation.
create or replace function rentview_private.guard_identity_deletion()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  -- DELETE has already locked the Auth row before this trigger. Do not wait
  -- on a billing worker that might need that row for a foreign-key check.
  if not pg_try_advisory_xact_lock(hashtextextended('billing-owner:'||old.id::text,0)) then
    raise exception 'Billing is being updated. Retry account deletion shortly.' using errcode='40001';
  end if;
  if exists(select 1 from public.account_deletion_requests where owner_id=old.id)
    and (exists(select 1 from public.billing_subscription_states where owner_id=old.id and status in ('active','trialing','past_due') and not cancel_at_period_end)
      or exists(select 1 from public.subscriptions where owner_id=old.id and status in ('active','trialing','past_due') and not cancel_at_period_end and provider_subscription_id is not null and billing_verified_at is not null)) then
    raise exception 'Cancel your subscription before deleting this account so billing cannot continue.' using errcode='P0001';
  end if;
  return old;
end;
$$;
revoke all on function rentview_private.guard_identity_deletion() from public,anon,authenticated;
create trigger rentview_guard_identity_deletion before delete on auth.users
 for each row execute function rentview_private.guard_identity_deletion();

create or replace function public.owned_storage_paths(p_owner_id uuid,p_limit integer default 100)
returns table(bucket_id text,name text) language sql security definer set search_path='' as $$
  select o.bucket_id,o.name from storage.objects o
    where coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner')=p_owner_id::text
    order by o.bucket_id,o.name limit greatest(1,least(coalesce(p_limit,100),1000));
$$;
revoke all on function public.owned_storage_paths(uuid,integer) from public,anon,authenticated;
grant execute on function public.owned_storage_paths(uuid,integer) to service_role;
create or replace function public.forget_deleted_uploads(p_owner_id uuid,p_paths text[])
returns void language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.account_deletion_requests where owner_id=p_owner_id) then raise exception 'Deletion has not started'; end if;
  -- Called only after Storage removal. Retained repair history must not show broken attachments.
  delete from public.request_photos where uploaded_by=p_owner_id and storage_path=any(p_paths);
  delete from public.documents where owner_id=p_owner_id and storage_path=any(p_paths);
end; $$;
revoke all on function public.forget_deleted_uploads(uuid,text[]) from public,anon,authenticated;
grant execute on function public.forget_deleted_uploads(uuid,text[]) to service_role;
create or replace function rentview_private.reject_deleting_account_writes()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is not null and coalesce(auth.jwt()->>'role','')<>'service_role' then
    if not exists(select 1 from auth.users where id=auth.uid()) or exists(select 1 from public.account_deletion_requests where owner_id=auth.uid()) then
      raise exception 'This account is being deleted. Further changes are disabled.' using errcode='42501';
    end if;
  end if;
  if tg_table_schema='storage' and tg_op='INSERT' and auth.uid() is not null and coalesce(auth.jwt()->>'role','')<>'service_role' then
    perform pg_advisory_xact_lock(hashtextextended('storage-rate:'||auth.uid()::text,0));
    if (select count(*) from storage.objects o where coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner')=auth.uid()::text and o.created_at>now()-interval '1 minute')>=100 then
      raise exception 'Too many uploads. Please wait a minute and try again.' using errcode='54000';
    end if;
  end if;
  return new;
end; $$;
revoke all on function rentview_private.reject_deleting_account_writes() from public,anon,authenticated;
do $$ declare t text; begin
  foreach t in array array['profiles','properties','units','leases','vendors','assets','work_orders','inventory_items','work_order_parts','expenses','tasks','maintenance_schedules','documents','maintenance_requests','tenant_invites','request_messages','request_photos','rent_payments','announcements','push_tokens','notification_prefs'] loop
    execute format('create trigger reject_deleting_account_writes before insert or update on public.%I for each row execute function rentview_private.reject_deleting_account_writes()',t);
  end loop;
end; $$;
create trigger reject_deleting_account_writes before insert or update on storage.objects
  for each row execute function rentview_private.reject_deleting_account_writes();

-- Restrict executable/browser-active uploads while retaining common receipts and office files.
update storage.buckets set file_size_limit=10485760,allowed_mime_types=array['image/jpeg','image/png','image/webp','image/heic','image/heif','image/gif','application/pdf','text/plain','text/csv','application/rtf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/vnd.oasis.opendocument.text','application/vnd.oasis.opendocument.spreadsheet'] where id='attachments';

-- Scheduler entry points contain no embedded secret. Vault is read only inside
-- privileged code; unconfigured projects retain pending work without dispatch.
create or replace function public.dispatch_due_notifications()
returns void language plpgsql security definer set search_path='' as $$
declare cfg record;
begin
  select * into cfg from public.push_hook_config();
  if cfg.hook_url is not null and cfg.hook_secret is not null then
    perform net.http_post(url:=cfg.hook_url,headers:=jsonb_build_object('Content-Type','application/json','x-push-secret',cfg.hook_secret),body:='{}'::jsonb);
  end if;
end; $$;
revoke all on function public.dispatch_due_notifications() from public,anon,authenticated;
grant execute on function public.dispatch_due_notifications() to service_role;
create or replace function public.dispatch_due_reminders()
returns void language plpgsql security definer set search_path='' as $$
declare hook_url text; hook_secret text;
begin
  select decrypted_secret into hook_url from vault.decrypted_secrets where name='reminders_hook_url' order by created_at desc limit 1;
  select decrypted_secret into hook_secret from vault.decrypted_secrets where name='reminders_hook_secret' order by created_at desc limit 1;
  if hook_url is not null and hook_secret is not null then
    perform net.http_post(url:=hook_url,headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',hook_secret),body:='{}'::jsonb);
  end if;
end; $$;
revoke all on function public.dispatch_due_reminders() from public,anon,authenticated;
grant execute on function public.dispatch_due_reminders() to service_role;
