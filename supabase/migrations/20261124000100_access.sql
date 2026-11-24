-- Keep the original owner IDs for existing clients while granting named staff
-- access through the property. Only the owner can delegate or hand it over.
create table public.property_managers (
  property_id uuid not null references public.properties on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  email text not null,
  assigned_at timestamptz not null default now(),
  primary key (property_id, user_id)
);
create index property_managers_by_user on public.property_managers(user_id);
create table public.manager_invitations (
  property_id uuid not null references public.properties on delete cascade,
  email text not null,
  expires_at timestamptz not null,
  primary key (property_id, email)
);
alter table public.property_managers enable row level security;
alter table public.manager_invitations enable row level security;
revoke all on public.property_managers, public.manager_invitations from public,anon,authenticated;
grant select on public.property_managers, public.manager_invitations to authenticated;
grant all on public.property_managers, public.manager_invitations to service_role;

create function public.can_manage_property(p_property uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.current_account_is_active() and exists (select from public.properties p where p.id = p_property and
    (p.owner_id = auth.uid() or exists (select from public.property_managers m
      where m.property_id = p.id and m.user_id = auth.uid())))
$$;
create function public.owns_property(p_property uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.current_account_is_active() and exists (select from public.properties where id = p_property and owner_id = auth.uid())
$$;
create policy manager_roster on public.property_managers for select to authenticated using (public.can_manage_property(property_id));
create policy pending_staff on public.manager_invitations for select to authenticated using (public.owns_property(property_id));

create function public.invite_property_manager(p_property uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare recipient text := lower(trim(p_email));
begin
  perform 1 from public.properties where id=p_property and public.owns_property(id) for update;
  if not found or coalesce(recipient,'') !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'Choose an owned property and enter a manager email address'; end if;
  insert into public.manager_invitations values(p_property, recipient, now()+interval '14 days')
  on conflict(property_id,email) do update set expires_at=excluded.expires_at;
end $$;
create function public.my_manager_invitations() returns table(property_id uuid, property_name text)
language sql stable security definer set search_path='' as $$
  select p.id,p.name from public.manager_invitations i join public.properties p on p.id=i.property_id
  join auth.users u on u.id=auth.uid() and u.email_confirmed_at is not null and lower(u.email)=i.email
  where public.current_account_is_active() and i.expires_at>now() and p.owner_id<>u.id
$$;
create function public.accept_manager_invitation(p_property uuid) returns void
language plpgsql security definer set search_path='' as $$
declare recipient text;
begin
  perform 1 from public.properties where id=p_property and public.current_account_is_active() and owner_id<>auth.uid() for update;
  if not found then raise exception 'Invitation unavailable'; end if;
  select lower(u.email) into recipient from auth.users u join public.profiles p on p.id=u.id
  where u.id=auth.uid() and u.email_confirmed_at is not null and p.role='owner';
  delete from public.manager_invitations where property_id=p_property and email=recipient and expires_at>now();
  if not found then raise exception 'Sign in with the invited, verified manager email'; end if;
  insert into public.property_managers(property_id,user_id,email) values(p_property,auth.uid(),recipient)
  on conflict do nothing;
end $$;
create function public.remove_property_manager(p_property uuid,p_email text) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.properties where id=p_property and public.owns_property(id) for update;
  if not found then raise exception 'Property owner required'; end if;
  delete from public.manager_invitations where property_id=p_property and email=lower(trim(p_email));
  delete from public.property_managers where property_id=p_property and email=lower(trim(p_email));
end $$;


-- Handover requires the successor to accept first, so it never strands a property.
create function public.handover_property_manager(p_property uuid,p_outgoing uuid,p_successor uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.properties where id=p_property and public.owns_property(id) for update;
  if not found or p_outgoing=p_successor or not exists(select from public.property_managers
    where property_id=p_property and user_id=p_successor) then raise exception 'Choose an accepted replacement manager'; end if;
  delete from public.property_managers where property_id=p_property and user_id=p_outgoing;
  if not found then raise exception 'Outgoing manager unavailable'; end if;
end $$;

-- Check owner IDs too: legacy composite keys installed NOT VALID may contain
-- quarantined historical mismatches, which must never expand manager access.
create function public.manages_owned_property(p_property uuid,p_owner uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select public.can_manage_property(p_property) and exists(select from public.properties where id=p_property and owner_id=p_owner)
$$;
create function public.can_manage_lease(p_lease uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select from public.leases l join public.units u on u.id=l.unit_id and u.owner_id=l.owner_id
    where l.id=p_lease and public.manages_owned_property(u.property_id,l.owner_id))
$$;
create function public.can_manage_job(p_job uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select from public.work_orders w where w.id=p_job and public.manages_owned_property(w.property_id,w.owner_id))
$$;

alter table public.vendors add column property_id uuid references public.properties on delete cascade;
create index vendors_property_idx on public.vendors(property_id);
create policy staff_read_property on public.properties for select to authenticated using(public.can_manage_property(id));
create policy staff_edit_property on public.properties for update to authenticated
using(public.can_manage_property(id)) with check(public.can_manage_property(id));

-- Existing clients supply their own login as owner_id. Normalize only a named
-- manager's own payload, under the same property scope enforced by the policy.
create function rentview_private.assign_record_owner() returns trigger
language plpgsql security definer set search_path='' as $$
declare fields jsonb:=to_jsonb(new); scope uuid; real_owner uuid;
begin
  if auth.uid() is null or new.owner_id is distinct from auth.uid() then return new; end if;
  if fields ? 'property_id' then scope := (fields->>'property_id')::uuid;
  elsif tg_table_name='leases' then select property_id into scope from public.units where id=new.unit_id;
  elsif tg_table_name='rent_payments' then select u.property_id into scope from public.leases l join public.units u on u.id=l.unit_id and u.owner_id=l.owner_id where l.id=new.lease_id;
  end if;
  select p.owner_id into real_owner from public.property_managers m join public.properties p on p.id=m.property_id
    where m.property_id=scope and m.user_id=auth.uid() and public.current_account_is_active();
  if found then new.owner_id:=real_owner; end if;
  return new;
end $$;
revoke all on function rentview_private.assign_record_owner() from public,anon,authenticated;
do $$ declare t text;
begin
  foreach t in array array['units','leases','assets','work_orders','inventory_items','expenses','tasks','maintenance_schedules','documents','rent_payments','announcements','vendors'] loop
    execute format('create trigger assign_record_owner before insert on public.%I for each row execute function rentview_private.assign_record_owner()',t);
    if t not in ('leases','rent_payments') then
      execute format('create policy property_staff on public.%I for all to authenticated using(public.manages_owned_property(property_id,owner_id)) with check(public.manages_owned_property(property_id,owner_id))',t);
    end if;
  end loop;
end $$;
create policy staff_leases_read on public.leases for select to authenticated using(public.can_manage_lease(id));
create policy staff_leases_write on public.leases for update to authenticated using(public.can_manage_lease(id)) with check(public.can_manage_lease(id));
create policy staff_leases_insert on public.leases for insert to authenticated with check(exists(select from public.units u where u.id=unit_id and u.owner_id=leases.owner_id and public.manages_owned_property(u.property_id,u.owner_id)));
-- A STABLE lookup of a new row by ID cannot satisfy INSERT RETURNING.
create policy staff_leases_insert_visibility on public.leases for select to authenticated using(exists(select from public.units u where u.id=unit_id and u.owner_id=leases.owner_id and public.manages_owned_property(u.property_id,u.owner_id)));
create policy staff_payments on public.rent_payments for all to authenticated
using(public.can_manage_lease(lease_id) and exists(select from public.leases l where l.id=lease_id and l.owner_id=rent_payments.owner_id))
with check(public.can_manage_lease(lease_id) and exists(select from public.leases l where l.id=lease_id and l.owner_id=rent_payments.owner_id));
create policy staff_invites_read on public.tenant_invites for select to authenticated using(public.can_manage_lease(lease_id));
create policy staff_invites_delete on public.tenant_invites for delete to authenticated using(public.can_manage_lease(lease_id));
create policy staff_requests_read on public.maintenance_requests for select to authenticated using(public.manages_owned_property(property_id,owner_id) and public.can_access_request(id));
create policy staff_requests_update on public.maintenance_requests for update to authenticated using(public.manages_owned_property(property_id,owner_id) and public.can_access_request(id)) with check(public.manages_owned_property(property_id,owner_id) and public.can_access_request(id));
create policy staff_work_order_parts on public.work_order_parts for select to authenticated using(public.can_manage_job(work_order_id));
create policy staff_events on public.work_order_events for select to authenticated using(public.can_manage_job(work_order_id));
create policy staff_movements on public.inventory_movements for select to authenticated using(public.can_manage_job(work_order_id));
create policy staff_maintenance_history on public.maintenance_completions for select to authenticated using(public.manages_owned_property(property_id,owner_id));
create policy staff_job_vendor on public.vendors for select to authenticated using(exists(select from public.work_orders w where w.vendor_id=vendors.id and w.owner_id=vendors.owner_id and public.manages_owned_property(w.property_id,w.owner_id)));

alter table public.leases add column archived_at timestamptz, add column portal_resident_id uuid references auth.users on delete set null;
-- Populate identity from current occupancy or the most recent legitimate claim.
update public.leases l set portal_resident_id=coalesce(l.tenant_user_id,(select i.claimed_by from public.tenant_invites i
 where i.lease_id=l.id and i.owner_id=l.owner_id and i.claimed_at is not null order by i.claimed_at desc limit 1))
where l.tenant_user_id is not null or exists(select from public.tenant_invites i where i.lease_id=l.id and i.claimed_at is not null);

create function public.lease_is_current(p_lease public.leases) returns boolean
language sql stable set search_path='' as $$
  select p_lease.archived_at is null and p_lease.status='active'
    and (p_lease.start_date is null or p_lease.start_date<=current_date)
    and (p_lease.end_date is null or p_lease.end_date>=current_date)
$$;
create or replace function public.is_tenant_of_lease(p_lease uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.leases l join public.units u on u.id=l.unit_id and u.owner_id=l.owner_id
    join public.properties p on p.id=u.property_id and p.owner_id=l.owner_id
    where l.id=p_lease and l.tenant_user_id=(select auth.uid()) and public.lease_is_current(l) and public.current_account_is_active());
$$;
create or replace function public.tenant_lease_matches(p_lease uuid,p_unit uuid,p_property uuid,p_owner uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.leases l join public.units u on u.id=l.unit_id and u.owner_id=l.owner_id
    join public.properties p on p.id=u.property_id and p.owner_id=l.owner_id
    where l.id=p_lease and l.tenant_user_id=(select auth.uid()) and public.lease_is_current(l)
      and l.unit_id=p_unit and u.property_id=p_property and l.owner_id=p_owner and public.current_account_is_active());
$$;
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
where l.tenant_user_id=(select auth.uid()) and public.lease_is_current(l) and public.current_account_is_active();
$$;
create or replace function public.can_access_request(p_request_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.maintenance_requests r
    join public.leases l on l.id=r.lease_id and l.owner_id=r.owner_id and l.unit_id=r.unit_id
    join public.units u on u.id=r.unit_id and u.property_id=r.property_id and u.owner_id=r.owner_id
    where r.id=p_request_id and public.current_account_is_active() and (public.manages_owned_property(r.property_id,r.owner_id) or
      (public.lease_is_current(l) and r.tenant_user_id=(select auth.uid()) and l.tenant_user_id=(select auth.uid()))));
$$;

create function public.can_read_request(p_request uuid) returns boolean language sql stable set search_path='' as $$
  select public.can_access_request(p_request)
$$;
create function public.can_post_request(p_request uuid) returns boolean language sql stable security definer set search_path='' as $$
  select public.can_access_request(p_request) and exists(select from public.maintenance_requests where id=p_request and status<>'closed')
$$;
create function public.revoke_lease_portal(p_lease uuid, p_archive boolean default false) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.leases where id=p_lease and public.can_manage_lease(id) for update;
  if not found then raise exception 'Lease unavailable'; end if;
  update public.leases set tenant_user_id=null,
    archived_at=case when p_archive then coalesce(archived_at,now()) else archived_at end,
    status=case when p_archive then 'terminated'::public.lease_status else status end
    where id=p_lease;
  delete from public.tenant_invites where lease_id=p_lease and claimed_at is null;
end $$;

create function public.lease_access_changed() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.archived_at is not null and (new.status,new.tenant_email,new.tenant_name,new.unit_id,new.archived_at)
     is distinct from (old.status,old.tenant_email,old.tenant_name,old.unit_id,old.archived_at) then
    raise exception 'Archived lease is historical. Create a new lease for a new tenancy'; end if;
  if old.portal_resident_id is not null and lower(trim(new.tenant_email)) is distinct from lower(trim(old.tenant_email))
    and old.tenant_email is not null then raise exception 'Create a new lease for a different resident'; end if;
  if new.status<>'active' or new.archived_at is not null or new.end_date<current_date then new.tenant_user_id:=null; end if;
  if new.tenant_email is distinct from old.tenant_email or new.tenant_user_id is distinct from old.tenant_user_id
    or new.status is distinct from old.status or new.archived_at is distinct from old.archived_at then
    update public.tenant_invites set expires_at=least(expires_at,now()) where lease_id=old.id and claimed_at is null;
  end if;
  return new;
end $$;
create trigger lease_access_change before update on public.leases for each row execute function public.lease_access_changed();


-- The archive operation replaces direct hard deletion. Parent-property/unit
-- deletion and the account-deletion worker retain their explicit semantics.
revoke delete on public.leases from authenticated;
create function rentview_private.guard_lease_archive_fields() returns trigger language plpgsql set search_path='' as $$
begin
  if current_user in ('authenticated','anon') and ((tg_op='INSERT' and (new.archived_at is not null or new.portal_resident_id is not null))
      or (tg_op='UPDATE' and (new.archived_at,new.portal_resident_id) is distinct from (old.archived_at,old.portal_resident_id))) then
    raise exception 'Use the tenant invitation or archive action' using errcode='42501'; end if;
  return new;
end $$;
create trigger guard_archive_fields before insert or update on public.leases for each row execute function rentview_private.guard_lease_archive_fields();
revoke all on function rentview_private.guard_lease_archive_fields() from public,anon,authenticated;
-- Legacy unbound invitations are revoked and may be reissued with a recipient.
update public.tenant_invites i set expires_at=least(expires_at,now()) where claimed_at is null and not exists(
 select from public.leases l where l.id=i.lease_id and l.owner_id=i.owner_id and l.tenant_user_id is null
 and public.lease_is_current(l) and nullif(lower(trim(i.email)),'')=lower(trim(l.tenant_email)));
create or replace function public.create_tenant_invite(p_lease_id uuid,p_email text default null)
returns public.tenant_invites language plpgsql security definer set search_path = '' as $$
declare l public.leases%rowtype; invitation public.tenant_invites%rowtype; uid uuid:=auth.uid();
begin
  if uid is null or not public.current_account_is_active() then raise exception 'Not authenticated' using errcode='42501'; end if;
  select * into l from public.leases where id=p_lease_id and public.can_manage_lease(id) for update;
  if not found or not exists(select 1 from public.units u join public.properties p on p.id=u.property_id and p.owner_id=u.owner_id where u.id=l.unit_id and u.owner_id=l.owner_id) then
    raise exception 'Lease not found' using errcode='42501';
  end if;
  if not public.lease_is_current(l) or l.tenant_user_id is not null then raise exception 'Only an active lease without portal access can be invited' using errcode='23514'; end if;
  p_email:=coalesce(nullif(trim(p_email),''),l.tenant_email);
  if p_email is null or lower(trim(p_email)) is distinct from lower(trim(l.tenant_email)) then
    raise exception 'Enter the resident email on the lease before inviting them' using errcode='23514'; end if;
  if (length(trim(p_email))>254 or trim(p_email) !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then raise exception 'Invalid invitation email' using errcode='23514'; end if;
  delete from public.tenant_invites where lease_id=l.id and claimed_at is null;
  insert into public.tenant_invites(owner_id,lease_id,code,email)
    values(l.owner_id,l.id,upper(replace(pg_catalog.gen_random_uuid()::text,'-','')),nullif(lower(trim(p_email)),'')) returning * into invitation;
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
  if found and invitation.claimed_at is not null and invitation.claimed_by=uid and public.lease_is_current(l) and l.tenant_user_id=uid and l.owner_id=invitation.owner_id then
    return json_build_object('lease_id',l.id);
  end if;
  if not found or invitation.claimed_at is not null or invitation.expires_at<=now() or invitation.owner_id=uid
    or l.owner_id is distinct from invitation.owner_id or not public.lease_is_current(l) or public.can_manage_lease(l.id) or (l.portal_resident_id is not null and l.portal_resident_id<>uid) or l.tenant_user_id is not null
    or not exists(select 1 from public.units u join public.properties p on p.id=u.property_id and p.owner_id=u.owner_id where u.id=l.unit_id and u.owner_id=l.owner_id) then
    raise exception 'Invalid or expired invitation' using errcode='23514';
  end if;
  if invitation.email is null or lower(trim(invitation.email)) is distinct from lower(trim(l.tenant_email)) then raise exception 'Invite recipient changed; ask for a new invitation' using errcode='42501'; end if;
  if invitation.email is not null then
    select lower(email) into user_email from auth.users where id=uid and email_confirmed_at is not null;
    if user_email is distinct from lower(trim(invitation.email)) then
      raise exception 'Sign in with the verified email address this invitation was sent to' using errcode='42501';
    end if;
  end if;
  update public.leases set tenant_user_id=uid,portal_resident_id=uid where id=l.id;
  update public.profiles set role='tenant' where id=uid and role='owner' and not exists(select 1 from public.properties p where p.owner_id=uid) and not exists(select from public.property_managers m where m.user_id=uid);
  update public.tenant_invites set claimed_by=uid,claimed_at=now() where id=invitation.id;
  delete from public.tenant_invites where lease_id=l.id and id<>invitation.id and claimed_at is null;
  return json_build_object('lease_id',l.id);
end;
$$;

-- Existing transactional operations retain all their validation, idempotency and posting rules.
create or replace function public.convert_request_to_work_order(p_request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests%rowtype; job_id uuid;
begin
  select * into r from public.maintenance_requests where id=p_request_id and public.manages_owned_property(property_id,owner_id) for update;
  if not found or auth.uid() is null then raise exception 'Request not found' using errcode='42501'; end if;
  if r.work_order_id is not null then return r.work_order_id; end if;
  if r.status in ('resolved','closed') then raise exception 'Reopen the request before creating another job' using errcode='23514'; end if;
  insert into public.work_orders(owner_id,property_id,unit_id,title,description,priority,status)
    values(r.owner_id,r.property_id,r.unit_id,r.title,r.description,r.urgency,'open') returning id into job_id;
  update public.maintenance_requests set work_order_id=job_id,status='acknowledged' where id=r.id;
  return job_id;
end;
$$;
create or replace function public.add_work_order_part(
 p_work_order_id uuid,p_inventory_item_id uuid,p_description text,p_quantity numeric,p_unit_cost numeric,p_currency text,p_operation_id uuid default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare w public.work_orders%rowtype; stock public.inventory_items%rowtype; part public.work_order_parts%rowtype;
 operation_id uuid:=coalesce(p_operation_id,pg_catalog.gen_random_uuid()); actual_cost numeric; actual_currency text; actual_description text;
begin
 if not public.current_account_is_active() then raise exception 'Not authenticated' using errcode='42501'; end if;
 select * into w from public.work_orders where id=p_work_order_id and public.manages_owned_property(property_id,owner_id) for update;
 if not found then raise exception 'Work order not found' using errcode='42501'; end if;
 if p_quantity is null or p_quantity<=0 or p_quantity in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) then raise exception 'Quantity must be finite and positive' using errcode='23514'; end if;
 -- Stock, parts and movements share numeric(12,2). Reject finer input before
 -- arithmetic so a consume/remove cycle cannot gain stock through rounding.
 if p_quantity<>round(p_quantity,2) then raise exception 'Quantity supports at most two decimal places' using errcode='23514'; end if;
 if p_unit_cost is not null and (p_unit_cost<0 or p_unit_cost in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)) then raise exception 'Cost must be finite and zero or positive' using errcode='23514'; end if;
 if p_currency is null or p_currency !~ '^[A-Z]{3}$' then raise exception 'Choose a three-letter currency' using errcode='23514'; end if;
 select * into part from public.work_order_parts where id=operation_id;
 if found then
  if part.owner_id<>w.owner_id or part.work_order_id<>w.id or part.operation_input is distinct from jsonb_build_object('inventory_item_id',p_inventory_item_id,'description',nullif(trim(p_description),''),'quantity',p_quantity,'unit_cost',p_unit_cost,'currency',p_currency) then
    raise exception 'Operation ID was already used for another part' using errcode='23514';
  end if;
  if part.removed_at is not null then raise exception 'Part was already removed. Start a new operation to add it again.' using errcode='23514'; end if;
  return part.id;
 end if;
 if w.status in ('completed','cancelled') or w.completion_expense_id is not null then raise exception 'Parts cannot be changed after a job is completed or cancelled' using errcode='23514'; end if;
 actual_cost:=p_unit_cost; actual_currency:=p_currency; actual_description:=nullif(trim(p_description),'');
 if p_inventory_item_id is not null then
  select * into stock from public.inventory_items where id=p_inventory_item_id and owner_id=w.owner_id and (owner_id=auth.uid() or property_id=w.property_id) for update;
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
 select * into part from public.work_order_parts where id=p_part_id and public.can_manage_job(work_order_id);
 if not found then return; end if;
 select * into w from public.work_orders where id=part.work_order_id and public.manages_owned_property(property_id,owner_id) for update;
 select * into part from public.work_order_parts where id=p_part_id and public.can_manage_job(work_order_id) for update;
 if not found or part.removed_at is not null then return; end if;
 if w.status in ('completed','cancelled') or w.completion_expense_id is not null then raise exception 'Parts cannot be changed after a job is completed or cancelled' using errcode='23514'; end if;
 if part.inventory_item_id is not null then
  update public.inventory_items set quantity=quantity+part.quantity where id=part.inventory_item_id and owner_id=w.owner_id;
  insert into public.inventory_movements(owner_id,inventory_item_id,work_order_id,part_id,quantity_change,reason)
   values(part.owner_id,part.inventory_item_id,part.work_order_id,part.id,part.quantity,'restored');
 end if;
 update public.work_order_parts set removed_at=now() where id=part.id;
end;
$$;
create or replace function public.complete_work_order(p_work_order_id uuid,p_labor_amount numeric,p_currency text,p_summary text default null,p_use_existing_expenses boolean default false,p_time_zone text default 'UTC')
returns uuid language plpgsql security definer set search_path = '' as $$
declare w public.work_orders%rowtype; parts_total numeric; expense_id uuid; invoice_total numeric; local_completed_on date;
begin
 if not public.current_account_is_active() then raise exception 'Not authenticated' using errcode='42501'; end if;
 local_completed_on:=rentview_private.calendar_date_at(statement_timestamp(),p_time_zone);
 -- Direct invoice writes and completion share one transaction lock. Take it
 -- before the job row so invoice-row triggers can fail retryably instead of
 -- deadlocking against a completion that references the same invoice.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('work-order-cost:'||p_work_order_id::text,613));
 select * into w from public.work_orders where id=p_work_order_id and public.manages_owned_property(property_id,owner_id) for update;
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
  values(w.owner_id,w.property_id,w.unit_id,w.id,w.vendor_id,'repair',coalesce(nullif(trim(p_summary),''),w.title),parts_total+p_labor_amount,p_currency,local_completed_on)
  returning id into expense_id;
 update public.work_orders set status='completed',completed_at=now(),cost=parts_total+p_labor_amount,cost_currency=p_currency,completion_expense_id=expense_id,completion_input=jsonb_build_object('labor',p_labor_amount,'currency',p_currency,'summary',nullif(trim(p_summary),''),'use_existing',p_use_existing_expenses) where id=w.id;
 insert into public.work_order_events(owner_id,work_order_id,asset_id,event_type,summary,data)
  values(w.owner_id,w.id,w.asset_id,'cost_posted',nullif(trim(p_summary),''),jsonb_build_object('expense_id',expense_id,'labor',p_labor_amount,'parts',parts_total,'currency',p_currency));
 return expense_id;
end;
$$;
create or replace function public.complete_maintenance_schedule(p_schedule_id uuid,p_completed_on date default null,p_notes text default null,p_time_zone text default 'UTC')
returns uuid language plpgsql security definer set search_path = '' as $$
declare s public.maintenance_schedules%rowtype; completion_id uuid; base_date date; due_date date; anchor integer; local_today date;
begin
 if not public.current_account_is_active() then raise exception 'Not authenticated' using errcode='42501'; end if;
 local_today:=rentview_private.calendar_date_at(statement_timestamp(),p_time_zone);
 p_completed_on:=coalesce(p_completed_on,local_today);
 select * into s from public.maintenance_schedules where id=p_schedule_id and (owner_id=auth.uid() or public.manages_owned_property(property_id,owner_id)) for update;
 if not found then raise exception 'Schedule not found' using errcode='42501'; end if;
 select id into completion_id from public.maintenance_completions where schedule_id=s.id and completed_on=p_completed_on;
 if found then return completion_id; end if;
 if not s.is_active then raise exception 'Resume this schedule before completing it' using errcode='23514'; end if;
 if p_completed_on is null or p_completed_on>local_today or (s.last_done is not null and p_completed_on<s.last_done) then raise exception 'Choose a valid completion date, not before the previous completion' using errcode='23514'; end if;
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
create or replace function public.asset_cost_totals(p_asset_id uuid)
returns table(currency text,total numeric) language sql stable security invoker set search_path = '' as $$
 select e.currency,sum(e.amount) from public.expenses e join public.work_orders w on w.id=e.work_order_id and w.owner_id=e.owner_id
 where w.asset_id=p_asset_id and public.manages_owned_property(w.property_id,e.owner_id) group by e.currency order by e.currency;
$$;

-- Persist the originating login independently of each canonical portfolio owner.
-- This lets an offline manager acknowledge an identical retry after a lost response.
create function rentview_private.stamp_record_author() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='INSERT' then new.created_by:=auth.uid();
  elsif new.created_by is distinct from old.created_by and current_user in ('authenticated','anon') then
    raise exception 'Record author cannot be edited' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function rentview_private.stamp_record_author() from public,anon,authenticated;
do $$ declare t text; begin
  foreach t in array array['units','leases','assets','work_orders','inventory_items','expenses','tasks','maintenance_schedules','documents','rent_payments','announcements','vendors'] loop
    execute format('alter table public.%I add column created_by uuid references auth.users on delete set null',t);
    execute format('create trigger stamp_author before insert or update on public.%I for each row execute function rentview_private.stamp_record_author()',t);
  end loop;
end $$;

-- Bind each uploaded object to its portfolio when metadata is saved. A manager
-- cannot share a guessed storage path, and a revoked uploader loses access.
create table rentview_private.document_file_scope (
  path text primary key, portfolio_owner uuid not null references auth.users on delete cascade,
  property_id uuid references public.properties on delete cascade
);
revoke all on rentview_private.document_file_scope from public,anon,authenticated;
insert into rentview_private.document_file_scope(path,portfolio_owner,property_id)
select d.storage_path,min(d.owner_id::text)::uuid,min(d.property_id::text)::uuid
from public.documents d where split_part(d.storage_path,'/',1)=d.owner_id::text
group by d.storage_path having count(distinct d.owner_id)=1 and count(distinct coalesce(d.property_id::text,''))=1;

create function rentview_private.bind_document_file() returns trigger language plpgsql security definer set search_path='' as $$
declare binding rentview_private.document_file_scope; uploader text := split_part(new.storage_path,'/',1);
begin
  if tg_op='UPDATE' and (old.storage_path,old.property_id,old.owner_id) is not distinct from (new.storage_path,new.property_id,new.owner_id) then return new; end if;
  if auth.uid() is null then return new; end if;
  -- Historical records may be moved to the consenting successor only by the
  -- handover function after it transfers the private binding.
  select * into binding from rentview_private.document_file_scope where path=new.storage_path;
  if found then
    if (binding.portfolio_owner,binding.property_id) is distinct from (new.owner_id,new.property_id)
      then raise exception 'File is already bound to a different property' using errcode='23514'; end if;
  else
    if uploader<>auth.uid()::text then raise exception 'Choose a file uploaded by this account' using errcode='42501'; end if;
    insert into rentview_private.document_file_scope values(new.storage_path,new.owner_id,new.property_id);
  end if;
  -- Change only Storage object ownership metadata. The object key and bytes
  -- stay in place. Account deletion of a departing manager now preserves it.
  if new.owner_id<>auth.uid() then
    update storage.objects set owner=new.owner_id,owner_id=new.owner_id::text
    where bucket_id='attachments' and name=new.storage_path and coalesce(nullif(owner_id,''),owner::text)=auth.uid()::text;
  end if;
  return new;
end $$;
create trigger bind_document_file after insert or update on public.documents for each row execute function rentview_private.bind_document_file();
revoke all on function rentview_private.bind_document_file() from public,anon,authenticated;

create function rentview_private.attachment_permission(p_path text) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((select portfolio_owner=auth.uid() or public.manages_owned_property(property_id,portfolio_owner)
    from rentview_private.document_file_scope where path=p_path),split_part(p_path,'/',1)=auth.uid()::text)
$$;
revoke all on function rentview_private.attachment_permission(text) from public,anon;
grant execute on function rentview_private.attachment_permission(text) to authenticated;
drop policy attachments_select_own on storage.objects;
drop policy attachments_update_own on storage.objects;
drop policy attachments_delete_own on storage.objects;
drop policy attachments_insert_own on storage.objects;
create policy attachments_read on storage.objects for select to authenticated using(bucket_id='attachments' and rentview_private.attachment_permission(name));
create policy attachments_add on storage.objects for insert to authenticated with check(bucket_id='attachments' and (storage.foldername(name))[1]=auth.uid()::text and rentview_private.attachment_permission(name));
create policy attachments_edit on storage.objects for update to authenticated using(bucket_id='attachments' and rentview_private.attachment_permission(name)) with check(bucket_id='attachments' and rentview_private.attachment_permission(name));
create policy attachments_remove on storage.objects for delete to authenticated using(bucket_id='attachments' and rentview_private.attachment_permission(name));

-- Ownership succession transfers the entire operator portfolio, including
-- shared vendors, unassigned inventory and records. Both parties must consent.
create table public.portfolio_transfers(
  from_owner uuid primary key references auth.users on delete cascade,
  to_manager uuid not null references auth.users on delete cascade,
  owner_email text not null,expires_at timestamptz not null,
  check(from_owner<>to_manager)
);
alter table public.portfolio_transfers enable row level security;
revoke all on public.portfolio_transfers from public,anon,authenticated;
grant select on public.portfolio_transfers to authenticated;
create policy transfer_parties on public.portfolio_transfers for select to authenticated
using(public.current_account_is_active() and auth.uid() in(from_owner,to_manager));

create function public.offer_portfolio_transfer(p_successor uuid) returns void language plpgsql security definer set search_path='' as $$
declare email text;
begin
  select u.email into email from auth.users u where u.id=auth.uid() and public.current_account_is_active();
  if email is null then raise exception 'Sign in to transfer a portfolio'; end if;
  if p_successor is null then delete from public.portfolio_transfers where from_owner=auth.uid(); return; end if;
  if not exists(select from public.properties where owner_id=auth.uid()) or exists(
    select from public.properties p where p.owner_id=auth.uid() and not exists(
      select from public.property_managers m where m.property_id=p.id and m.user_id=p_successor))
  then raise exception 'The successor must first accept a manager invitation on every owned property'; end if;
  insert into public.portfolio_transfers values(auth.uid(),p_successor,email,now()+interval '7 days')
  on conflict(from_owner) do update set to_manager=excluded.to_manager,expires_at=excluded.expires_at;
end $$;

-- Composite owner keys remain enforced on all normal writes. A handover
-- updates their shared owner transactionally across the parent/child graph.
do $$ declare fk record; begin
  for fk in select c.conrelid::regclass as relation,c.conname from pg_catalog.pg_constraint c
    join pg_catalog.pg_namespace n on n.oid=c.connamespace
    where n.nspname='public' and c.contype='f' and cardinality(c.conkey)>1
      and exists(select from pg_catalog.pg_attribute a where a.attrelid=c.conrelid and a.attnum=any(c.conkey) and a.attname='owner_id')
  loop execute format('alter table %s alter constraint %I deferrable initially immediate',fk.relation,fk.conname); end loop;
end $$;
-- The caller cannot set this private table or spoof the transaction ID.
create table rentview_private.owner_change(txid bigint primary key, original uuid not null, successor uuid not null);
revoke all on rentview_private.owner_change from public,anon,authenticated;
create or replace function rentview_private.guard_row_identity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.id is distinct from old.id or (new.owner_id is distinct from old.owner_id and not exists(
    select from rentview_private.owner_change where txid=txid_current() and original=old.owner_id and successor=new.owner_id
  )) then raise exception 'Record identity and ownership cannot be changed' using errcode='23514'; end if;
  return new;
end $$;

create function public.accept_portfolio_transfer(p_owner uuid) returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); t text; count_after integer;
begin
  if not public.current_account_is_active() or uid=p_owner then raise exception 'Transfer unavailable'; end if;
  -- Serialize offers and quota checks with property creation and manager removal.
  perform pg_advisory_xact_lock(hashtextextended(least(uid,p_owner)::text,611));
  perform pg_advisory_xact_lock(hashtextextended(greatest(uid,p_owner)::text,611));
  perform 1 from auth.users where id in(uid,p_owner) order by id for update;
  if exists(select from public.account_deletion_requests where owner_id in(uid,p_owner)) then raise exception 'Account deletion is in progress'; end if;
  perform 1 from public.portfolio_transfers where from_owner=p_owner and to_manager=uid and expires_at>now() for update;
  if not found then raise exception 'Transfer unavailable'; end if;
  -- Prevent child rows being added during ownership propagation.
  lock table public.properties,public.units,public.assets,public.leases,public.vendors,public.inventory_items,
    public.work_orders,public.work_order_parts,public.expenses,public.maintenance_schedules,public.documents,public.tasks,
    public.maintenance_requests,public.tenant_invites,public.rent_payments,public.announcements,
    public.work_order_events,public.maintenance_completions,public.inventory_movements in share row exclusive mode;
  if not exists(select from public.properties where owner_id=p_owner) or exists(
    select from public.properties p where p.owner_id=p_owner and not exists(select from public.property_managers m where m.property_id=p.id and m.user_id=uid))
  then raise exception 'Property assignments changed; review the transfer with the owner'; end if;
  select count(*) into count_after from public.properties where owner_id in(uid,p_owner);
  if count_after>3 and not exists(select from public.subscriptions s where s.owner_id=uid and s.billing_verified_at is not null and s.plan='pro'
    and (s.status in('active','trialing','past_due') or (s.status='cancelled' and s.current_period_end>now())))
  then raise exception 'The successor needs Pro capacity for this portfolio'; end if;
  insert into rentview_private.owner_change values(txid_current(),p_owner,uid);
  set constraints all deferred;
  delete from public.manager_invitations where property_id in(select id from public.properties where owner_id=p_owner);
  delete from public.property_managers where user_id in(uid,p_owner) and property_id in(select id from public.properties where owner_id=p_owner);
  update rentview_private.document_file_scope set portfolio_owner=uid where portfolio_owner=p_owner;
  update storage.objects o set owner=uid,owner_id=uid::text where o.bucket_id='attachments'
    and coalesce(nullif(o.owner_id,''),o.owner::text)=p_owner::text and (exists(
    select from rentview_private.document_file_scope f where f.path=o.name and f.portfolio_owner=uid) or exists(
    select from public.request_photos f join public.maintenance_requests r on r.id=f.request_id where r.owner_id=p_owner and f.storage_path=o.name));
  foreach t in array array['properties','units','vendors','leases','assets','inventory_items','work_orders','expenses','work_order_parts',
    'tasks','maintenance_schedules','documents','maintenance_requests','rent_payments','tenant_invites','announcements',
    'inventory_movements','maintenance_completions','work_order_events'] loop
    execute format('update public.%I set owner_id=$1 where owner_id=$2',t) using uid,p_owner;
  end loop;
  delete from rentview_private.owner_change where txid=txid_current();
  delete from public.portfolio_transfers where from_owner=p_owner;
  set constraints all immediate;
end $$;

-- Never expose default PUBLIC execute on the new RPCs or internal triggers.
do $$ declare name regprocedure; begin
  foreach name in array array[
    'public.can_manage_property(uuid)'::regprocedure,'public.owns_property(uuid)','public.manages_owned_property(uuid,uuid)',
    'public.can_manage_lease(uuid)','public.can_manage_job(uuid)','public.can_read_request(uuid)','public.can_post_request(uuid)',
    'public.lease_is_current(public.leases)','public.revoke_lease_portal(uuid,boolean)','public.invite_property_manager(uuid,text)',
    'public.accept_manager_invitation(uuid)','public.my_manager_invitations()','public.remove_property_manager(uuid,text)',
    'public.handover_property_manager(uuid,uuid,uuid)','public.offer_portfolio_transfer(uuid)','public.accept_portfolio_transfer(uuid)'
  ] loop execute format('revoke all on function %s from public,anon',name);
    execute format('grant execute on function %s to authenticated,service_role',name); end loop;
end $$;
revoke all on function public.lease_access_changed() from public,anon,authenticated;
notify pgrst,'reload schema';

create function public.cancel_portfolio_transfer() returns void language sql security definer set search_path='' as $$
 delete from public.portfolio_transfers where from_owner=auth.uid() and public.current_account_is_active()
$$;
revoke all on function public.cancel_portfolio_transfer() from public,anon;
grant execute on function public.cancel_portfolio_transfer() to authenticated;
