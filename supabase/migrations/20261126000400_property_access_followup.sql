-- Managers can maintain records. Permanent removal remains with their owner.
do $$
declare
  t text;
  scope text;
begin
  foreach t in array array['units','assets','work_orders','inventory_items','expenses','tasks',
    'maintenance_schedules','documents','announcements','vendors','rent_payments'] loop
    if t='rent_payments' then
      drop policy staff_payments on public.rent_payments;
      scope := 'public.can_manage_lease(lease_id) and exists(select from public.leases l where l.id=lease_id and l.owner_id=rent_payments.owner_id)';
    else
      execute format('drop policy property_staff on public.%I',t);
      scope := 'public.manages_owned_property(property_id,owner_id)';
    end if;
    execute format('create policy staff_read on public.%I for select to authenticated using (%s)',t,scope);
    execute format('create policy staff_add on public.%I for insert to authenticated with check (%s)',t,scope);
    execute format('create policy staff_edit on public.%I for update to authenticated using (%s) with check (%s)',t,scope,scope);
  end loop;
end $$;

-- Storage mutation follows native ownership. A delegated reader can still upload
-- a fresh object and bind it to the portfolio through document creation.
create index documents_by_storage_path on public.documents(storage_path,owner_id);
drop policy attachments_edit on storage.objects;
drop policy attachments_remove on storage.objects;
create policy attachments_edit on storage.objects for update to authenticated
using (bucket_id='attachments' and coalesce(nullif(owner_id,''),owner::text)=auth.uid()::text
       and rentview_private.attachment_permission(name))
with check (bucket_id='attachments' and coalesce(nullif(owner_id,''),owner::text)=auth.uid()::text
       and rentview_private.attachment_permission(name));
create policy attachments_remove on storage.objects for delete to authenticated
using (bucket_id='attachments' and coalesce(nullif(owner_id,''),owner::text)=auth.uid()::text
       and rentview_private.attachment_permission(name)
       and not exists(select from public.documents d where d.owner_id=(select auth.uid())
                      and d.storage_path=objects.name));

-- A signed lease can be claimed before move-in. Resident data remains scoped
-- by lease_is_current, including its inclusive start and end dates (UTC).
create or replace function public.lease_is_current(p_lease public.leases) returns boolean
language sql stable set search_path='' as $$
  select p_lease.archived_at is null and p_lease.status='active'
    and (p_lease.start_date is null or p_lease.start_date<=(now() at time zone 'UTC')::date)
    and (p_lease.end_date is null or p_lease.end_date>=(now() at time zone 'UTC')::date)
$$;
create function rentview_private.lease_accepts_invite(l public.leases) returns boolean
language sql stable set search_path='' as $$
  select l.archived_at is null and l.status='active' and (l.end_date is null or l.end_date>=(now() at time zone 'UTC')::date)
$$;
revoke all on function rentview_private.lease_accepts_invite(public.leases) from public,anon,authenticated,service_role;

create or replace function public.create_tenant_invite(p_lease_id uuid,p_email text default null)
returns public.tenant_invites language plpgsql security definer set search_path = '' as $$
declare l public.leases%rowtype; invitation public.tenant_invites%rowtype; uid uuid:=auth.uid();
begin
  if uid is null or not public.current_account_is_active() then raise exception 'Not authenticated' using errcode='42501'; end if;
  select * into l from public.leases where id=p_lease_id and public.can_manage_lease(id) for update;
  if not found or not exists(select 1 from public.units u join public.properties p on p.id=u.property_id and p.owner_id=u.owner_id where u.id=l.unit_id and u.owner_id=l.owner_id) then
    raise exception 'Lease not found' using errcode='42501';
  end if;
  if not rentview_private.lease_accepts_invite(l) or l.tenant_user_id is not null then raise exception 'Only an active lease without portal access can be invited' using errcode='23514'; end if;
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

create or replace function rentview_private.claim_tenant_invite_checked(invite_code text)
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
  if found and invitation.claimed_at is not null and invitation.claimed_by=uid and rentview_private.lease_accepts_invite(l) and l.tenant_user_id=uid and l.owner_id=invitation.owner_id then
    return json_build_object('lease_id',l.id);
  end if;
  if not found or invitation.claimed_at is not null or invitation.expires_at<=now() or invitation.owner_id=uid
    or l.owner_id is distinct from invitation.owner_id or not rentview_private.lease_accepts_invite(l) or public.can_manage_lease(l.id) or (l.portal_resident_id is not null and l.portal_resident_id<>uid) or l.tenant_user_id is not null
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
revoke all on function rentview_private.claim_tenant_invite_checked(text) from public,anon,authenticated,service_role;

-- Deployments may have applied the original access migration after the PR3
-- limiter was installed. Restore the same public entry point in either order.
create or replace function public.claim_tenant_invite(invite_code text) returns json
language sql security definer set search_path='' as $$
  select rentview_private.claim_tenant_invite_throttled(invite_code)
$$;
revoke all on function public.claim_tenant_invite(text) from public,anon,service_role;
grant execute on function public.claim_tenant_invite(text) to authenticated;

create or replace function public.accept_manager_invitation(p_property uuid) returns void
language plpgsql security definer set search_path='' as $$
declare recipient text;
begin
  perform 1 from public.properties where id=p_property and public.current_account_is_active() and owner_id<>auth.uid() for update;
  if not found then raise exception 'Invitation unavailable'; end if;
  select lower(u.email) into recipient from auth.users u join public.profiles p on p.id=u.id
  where u.id=auth.uid() and u.email_confirmed_at is not null and p.role='owner';
  if exists(select from auth.users u join public.profiles p on p.id=u.id
    join public.manager_invitations i on i.email=lower(u.email) and i.property_id=p_property and i.expires_at>now()
    where u.id=auth.uid() and u.email_confirmed_at is not null and p.role<>'owner') then
    raise exception 'Use a property manager account to accept this invitation' using errcode='42501';
  end if;
  delete from public.manager_invitations where property_id=p_property and email=recipient and expires_at>now();
  if not found then raise exception 'Sign in with the invited, verified manager email'; end if;
  insert into public.property_managers(property_id,user_id,email) values(p_property,auth.uid(),recipient)
  on conflict do nothing;
end $$;

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
 if w.status='completed' or w.completion_expense_id is not null then raise exception 'Parts cannot be changed after job costs have been posted' using errcode='23514'; end if;
 if part.inventory_item_id is not null then
  update public.inventory_items set quantity=quantity+part.quantity where id=part.inventory_item_id and owner_id=w.owner_id;
  insert into public.inventory_movements(owner_id,inventory_item_id,work_order_id,part_id,quantity_change,reason)
   values(part.owner_id,part.inventory_item_id,part.work_order_id,part.id,part.quantity,'restored');
 end if;
 update public.work_order_parts set removed_at=now() where id=part.id;
end;
$$;

create or replace function rentview_private.bind_document_file() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  binding rentview_private.document_file_scope;
  uid uuid := auth.uid();
begin
  if uid is null then return new; end if;
  if tg_op='UPDATE' then
    if (old.storage_path,old.property_id,old.owner_id) is not distinct from
       (new.storage_path,new.property_id,new.owner_id) then return new; end if;
    -- accept_portfolio_transfer reconciled the full set, including shared paths.
    if old.storage_path=new.storage_path and old.property_id is not distinct from new.property_id
       and exists(select from rentview_private.owner_change where txid=txid_current()
                  and original=old.owner_id and successor=new.owner_id) then return new; end if;
  end if;
  if split_part(new.storage_path,'/',1)=uid::text then
    insert into rentview_private.document_file_scope values(new.storage_path,new.owner_id,new.property_id)
      on conflict(path) do nothing;
  end if;
  select * into binding from rentview_private.document_file_scope where path=new.storage_path for update;
  if not found or binding.portfolio_owner<>new.owner_id then
    raise exception 'Choose a file uploaded by this account' using errcode='42501';
  end if;
  if binding.property_id is distinct from new.property_id then
    -- Only an owner editing the existing document may change its file's audience.
    if tg_op<>'UPDATE' or new.owner_id<>uid or old.storage_path<>new.storage_path
       or exists(select from public.documents d where d.storage_path=new.storage_path and d.id<>new.id
                 and (d.owner_id,d.property_id) is distinct from (new.owner_id,new.property_id)) then
      raise exception 'File is already bound to a different property' using errcode='23514';
    end if;
    update rentview_private.document_file_scope set property_id=new.property_id where path=new.storage_path;
  end if;
  if new.owner_id<>uid then
    update storage.objects set owner=new.owner_id,owner_id=new.owner_id::text
    where bucket_id='attachments' and name=new.storage_path and coalesce(nullif(owner_id,''),owner::text)=uid::text;
  end if;
  return new;
end $$;

-- Normal writes from different portfolios never share a lock. A writer that
-- already holds a row lock must retry rather than wait behind the handover.
create function rentview_private.guard_portfolio_writer() returns trigger
language plpgsql set search_path='' as $$
declare portfolio uuid;
begin
  portfolio := case when tg_op='DELETE' then old.owner_id else new.owner_id end;
  if not pg_try_advisory_xact_lock_shared(hashtextextended(portfolio::text,611)) then
    raise exception 'Portfolio transfer is in progress. Retry the change.' using errcode='40001';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function rentview_private.guard_portfolio_writer() from public,anon,authenticated,service_role;
do $$ declare t text; begin
  foreach t in array array['properties','units','vendors','leases','assets','inventory_items','work_orders','expenses',
    'work_order_parts','tasks','maintenance_schedules','documents','maintenance_requests','rent_payments','tenant_invites',
    'announcements','inventory_movements','maintenance_completions','work_order_events'] loop
    -- Runs after assign_record_owner has resolved a manager's canonical owner.
    execute format('create trigger portfolio_writer before insert or update or delete on public.%I
      for each row execute function rentview_private.guard_portfolio_writer()',t);
  end loop;
end $$;

create or replace function public.accept_portfolio_transfer(p_owner uuid) returns void language plpgsql security definer set search_path='' as $$
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
  perform 1 from public.properties where owner_id=p_owner order by id for update;
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
  -- A legacy object reused across properties stays owner-only until the owner
  -- chooses a single location. Never claim a path belonging to another portfolio.
  insert into rentview_private.document_file_scope(path,portfolio_owner,property_id)
  select d.storage_path,p_owner,
    case when count(distinct coalesce(d.property_id::text,''))=1 then min(d.property_id::text)::uuid end
  from public.documents d
  join storage.objects o on o.bucket_id='attachments' and o.name=d.storage_path
  where d.owner_id=p_owner and coalesce(nullif(o.owner_id,''),o.owner::text)=p_owner::text
    and not exists(select from public.documents other where other.storage_path=d.storage_path and other.owner_id<>p_owner)
  group by d.storage_path on conflict(path) do nothing;
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

notify pgrst,'reload schema';
