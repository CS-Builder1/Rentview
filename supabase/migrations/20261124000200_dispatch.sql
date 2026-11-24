-- Job participants use a narrow projection and explicit actions. Internal work orders,
-- vendor contacts, parts, and cost records continue to use the owner/manager policies.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('owner','tenant','contractor'));

create table public.contractor_accounts (
  vendor_id uuid primary key references public.vendors(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  linked_at timestamptz not null default now()
);
create index contractor_accounts_user on public.contractor_accounts(user_id);
create table public.contractor_invites (
  vendor_id uuid primary key references public.vendors(id) on delete cascade,
  code_hash bytea not null unique,
  email text not null,
  expires_at timestamptz not null
);
create table public.work_order_dispatch (
  work_order_id uuid primary key references public.work_orders(id) on delete cascade,
  assignment_status text check (assignment_status in ('pending','accepted','declined','completed')),
  instructions text check(length(instructions) <= 4000),
  visit_status text not null default 'none' check(visit_status in ('none','proposed','confirmed')),
  visit_start timestamptz,
  visit_end timestamptz,
  proposed_by uuid references auth.users(id) on delete set null,
  proposed_by_tenant boolean,
  field_completed_at timestamptz,
  completion_notes text,
  completion_photos text[] not null default '{}',
  revision integer not null default 1,
  updated_at timestamptz not null default now(),
  check ((visit_status='none' and visit_start is null and visit_end is null)
    or (visit_status<>'none' and visit_start is not null and visit_end>visit_start))
);
-- No cascading job FK here: preserve historical records even after operational deletion.
create table public.dispatch_history (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid,
  property_id uuid not null,
  owner_id uuid not null,
  actor_id uuid,
  event text not null,
  detail jsonb not null,
  created_at timestamptz not null default now()
);
create index dispatch_history_job on public.dispatch_history(work_order_id,created_at);
create index dispatch_history_property on public.dispatch_history(property_id,created_at);

alter table public.contractor_accounts enable row level security;
alter table public.contractor_invites enable row level security;
alter table public.work_order_dispatch enable row level security;
alter table public.dispatch_history enable row level security;
revoke all on public.contractor_accounts, public.contractor_invites, public.work_order_dispatch, public.dispatch_history
  from public, anon, authenticated;
grant select on public.dispatch_history to authenticated;
create policy dispatch_history_management on public.dispatch_history for select to authenticated
  using ((select public.current_account_is_active()) and public.can_manage_property(property_id));

insert into public.work_order_dispatch(work_order_id,assignment_status)
  select id,case when vendor_id is null then null when status='completed' then 'completed' else 'pending' end
  from public.work_orders;

create function public.is_assigned_contractor(p_work_order uuid,p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.work_orders w
    join public.properties p on p.id=w.property_id and p.owner_id=w.owner_id
    join public.work_order_dispatch d on d.work_order_id=w.id and d.assignment_status <> 'declined'
    join public.vendors v on v.id=w.vendor_id and v.owner_id=w.owner_id and (v.property_id is null or v.property_id=w.property_id)
    join public.contractor_accounts c on c.vendor_id=v.id
    where w.id=p_work_order and c.user_id=p_user);
$$;
revoke all on function public.is_assigned_contractor(uuid,uuid) from public,anon,authenticated;

-- Security-barrier projection. Deliberately runs with view-owner rights: the underlying
-- tables are private, and every result is filtered using the signed-in caller's identity.
create view public.dispatch_jobs with (security_barrier=true) as
  select w.id as work_order_id, r.id as request_id, w.title, r.description, w.priority,
    w.status as work_status, p.name as property_name,u.label as unit_label,
    concat_ws(', ',nullif(p.address_line1,''),nullif(p.address_line2,''),nullif(p.city,''),
      nullif(p.region,''),nullif(p.postal_code,''),nullif(p.country,'')) as address,
    v.id as vendor_id,v.name as vendor_name,d.assignment_status,d.instructions,d.visit_status,
    d.visit_start,d.visit_end,d.proposed_by,d.completion_notes,d.completion_photos,d.revision,
    c.user_id is not null as vendor_linked, d.field_completed_at,
    (d.visit_status='proposed' and d.assignment_status='accepted' and d.visit_start>now() and d.proposed_by is distinct from (select auth.uid()) and
      ((not d.proposed_by_tenant and (r.tenant_user_id=(select auth.uid()) and public.can_access_request(r.id)))
        or (d.proposed_by_tenant and (c.user_id=(select auth.uid()) or public.can_manage_property(w.property_id)))
        or (r.id is null and d.proposed_by is distinct from (select auth.uid())
          and (c.user_id=(select auth.uid()) or public.can_manage_property(w.property_id))))) is true as can_confirm
  from public.work_orders w
  join public.work_order_dispatch d on d.work_order_id=w.id
  join public.properties p on p.id=w.property_id and p.owner_id=w.owner_id
  left join public.units u on u.id=w.unit_id and u.property_id=p.id and u.owner_id=p.owner_id
  left join public.vendors v on v.id=w.vendor_id and v.owner_id=p.owner_id and (v.property_id is null or v.property_id=w.property_id)
  left join public.contractor_accounts c on c.vendor_id=v.id
  left join public.maintenance_requests r on r.work_order_id=w.id and r.owner_id=w.owner_id
    and r.property_id=w.property_id and r.unit_id=w.unit_id
  where (select public.current_account_is_active()) and (w.owner_id=(select auth.uid())
    or public.can_manage_property(w.property_id)
    or (c.user_id=(select auth.uid()) and d.assignment_status <> 'declined')
    or (r.tenant_user_id=(select auth.uid()) and public.can_access_request(r.id)));
revoke all on public.dispatch_jobs from public,anon,authenticated;
grant select on public.dispatch_jobs to authenticated;

create function public.my_dispatch_jobs() returns setof public.dispatch_jobs
language sql stable security definer set search_path='' as $$
  select j.* from public.dispatch_jobs j
  where public.is_assigned_contractor(j.work_order_id,(select auth.uid()))
  order by j.visit_start nulls last,j.title,j.work_order_id;
$$;

-- A durable snapshot and all recipient events are recorded in the same transaction as
-- the underlying change. The inbox migration installs the recipient delivery function.
create function public.dispatch_record_event(p_job uuid,p_event text,p_title text,p_body text,
  p_audience text[] default array['management','worker','tenant'],p_extra jsonb default '{}')
returns void language plpgsql security definer set search_path='' as $$
declare
  w public.work_orders%rowtype;
  d public.work_order_dispatch%rowtype;
  target record;
begin
  select * into strict w from public.work_orders where id=p_job;
  select * into strict d from public.work_order_dispatch where work_order_id=p_job;
  insert into public.dispatch_history(work_order_id,property_id,owner_id,actor_id,event,detail)
    values(w.id,w.property_id,w.owner_id,auth.uid(),p_event,
      to_jsonb(d) || jsonb_build_object('vendor_id',w.vendor_id,'work_status',w.status,
                    'title',w.title,'vendor_name',(select name from public.vendors where id=w.vendor_id and owner_id=w.owner_id),'completed_at',w.completed_at) || p_extra);
  if to_regprocedure('public.deliver_inbox_event(uuid,text,text,text,uuid,uuid,uuid,boolean)') is null then return; end if;
  for target in
    select distinct on (recipient) recipient,href,lease_id,request_id from (
      select w.owner_id recipient,'/work-order/'||w.id href,null::uuid lease_id,null::uuid request_id
        where 'management'=any(p_audience)
      union all
      select c.user_id,'/contractor/job/'||w.id,null::uuid,null::uuid
        from public.contractor_accounts c join public.vendors v on v.id=c.vendor_id
        where v.id=w.vendor_id and v.owner_id=w.owner_id and (v.property_id is null or v.property_id=w.property_id) and 'worker'=any(p_audience)
      union all
      select r.tenant_user_id,'/tenant/request/'||r.id,r.lease_id,r.id
        from public.maintenance_requests r
        where r.work_order_id=w.id and r.property_id=w.property_id and r.owner_id=w.owner_id
          and r.unit_id=w.unit_id and 'tenant'=any(p_audience)
      union all
      select m.user_id,'/work-order/'||w.id,null::uuid,null::uuid
        from public.property_managers m
        where m.property_id=w.property_id and 'management'=any(p_audience)
    ) recipients where recipient is distinct from auth.uid() or p_event='invite_claimed'
  loop
    perform public.deliver_inbox_event(target.recipient,p_title,p_body,target.href,w.property_id,
                                       target.lease_id,target.request_id,true);
  end loop;
end;
$$;
revoke all on function public.dispatch_record_event(uuid,text,text,text,text[],jsonb) from public,anon,authenticated;

create function public.create_contractor_invite(p_vendor uuid) returns text
language plpgsql security definer set search_path='' as $$
declare
  v public.vendors%rowtype;
  code text := replace(gen_random_uuid()::text,'-','');
begin
  select * into v from public.vendors where id=p_vendor for update;
  if not found or not public.current_account_is_active() or (v.owner_id<>auth.uid() and
      (v.property_id is null or not public.manages_owned_property(v.property_id,v.owner_id))) then
    raise exception 'Vendor unavailable';
  end if;
  if nullif(trim(v.email),'') is null then raise exception 'Save the contractor email before inviting them'; end if;
  if exists(select from public.contractor_accounts where vendor_id=v.id) then
    raise exception 'Contractor already connected';
  end if;
  insert into public.contractor_invites(vendor_id,code_hash,email,expires_at)
    values(v.id,sha256(convert_to(code,'UTF8')),lower(trim(v.email)),now()+interval '7 days')
    on conflict(vendor_id) do update set code_hash=excluded.code_hash,email=excluded.email,expires_at=excluded.expires_at;
  return code;
end;
$$;

create function public.claim_contractor_invite(p_code text) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  i public.contractor_invites%rowtype;
  account_email text;
  account_role text;
  job uuid;
begin
  select lower(trim(email)) into account_email from auth.users
    where id=auth.uid() and email_confirmed_at is not null;
  if p_code is null or length(p_code)>96 then raise exception 'Invalid contractor invitation'; end if;
  -- All issue/claim/contact-change paths lock the vendor first and revalidate the
  -- invitation under that lock, including the current verified contact email.
  perform 1 from public.vendors v join public.contractor_invites candidate on candidate.vendor_id=v.id
    where candidate.code_hash=sha256(convert_to(lower(trim(p_code)),'UTF8')) for update of v;
  select * into i from public.contractor_invites
    where code_hash=sha256(convert_to(lower(trim(p_code)),'UTF8')) and expires_at>now() for update;
  if not found or not public.current_account_is_active() or account_email is null or account_email<>i.email or not exists(
      select from public.vendors v where v.id=i.vendor_id and lower(trim(v.email))=i.email and v.owner_id<>auth.uid()) then
    raise exception 'Invite unavailable for this verified email address';
  end if;
  select role into account_role from public.profiles where id=auth.uid() for update;
  if account_role is null then raise exception 'Sign in again'; end if;
  insert into public.contractor_accounts(vendor_id,user_id) values(i.vendor_id,auth.uid());
  -- Existing portfolios and lease memberships keep their regular home screen;
  -- the contractor jobs route is a secondary context on those accounts.
  if account_role='owner'
    and not exists(select from public.properties where owner_id=auth.uid())
    and not exists(select from public.leases where tenant_user_id=auth.uid())
    and not exists(select from public.property_managers where user_id=auth.uid())
    and not exists(select from public.vendors where owner_id=auth.uid())
    and not exists(select from public.expenses where owner_id=auth.uid())
    and not exists(select from public.assets where owner_id=auth.uid())
    and not exists(select from public.inventory_items where owner_id=auth.uid())
    and not exists(select from public.documents where owner_id=auth.uid())
    and not exists(select from public.maintenance_schedules where owner_id=auth.uid())
    and not exists(select from public.tasks where owner_id=auth.uid())
    and not exists(select from public.subscriptions where owner_id=auth.uid() and plan='pro') then
    update public.profiles set role='contractor' where id=auth.uid();
  end if;
  delete from public.contractor_invites where vendor_id=i.vendor_id;
  for job in select w.id from public.work_orders w join public.work_order_dispatch d on d.work_order_id=w.id
    where w.vendor_id=i.vendor_id and d.assignment_status='pending' and w.status not in ('completed','cancelled')
  loop
    perform public.dispatch_record_event(job,'invite_claimed','New job assignment','Open the job to accept or decline.',
      array['worker']);
  end loop;
  return i.vendor_id;
end;
$$;

-- Keep dispatch synchronized even when an older owner app changes the vendor directly.
alter table public.work_orders add column dispatch_instructions text check(length(dispatch_instructions)<=4000);

create function rentview_private.track_dispatch_order() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  previous_worker uuid;
  changed_vendor boolean := tg_op='INSERT' or new.vendor_id is distinct from old.vendor_id;
  action text;
begin
  if changed_vendor and new.vendor_id is not null and not exists(
    select from public.vendors v where v.id=new.vendor_id and v.owner_id=new.owner_id
      and (v.property_id is null or v.property_id=new.property_id)
  ) then raise exception 'Choose a vendor for this property'; end if;
  if tg_op='INSERT' then
    insert into public.work_order_dispatch(work_order_id,assignment_status,instructions)
    values(new.id,case when new.vendor_id is null then null when new.status='completed' then 'completed' else 'pending' end,
           new.dispatch_instructions);
  elsif changed_vendor then
    if new.vendor_id is not null and (new.status in ('completed','cancelled') or new.completion_expense_id is not null)
      then raise exception 'This work order is finished'; end if;
    select user_id into previous_worker from public.contractor_accounts where vendor_id=old.vendor_id;
    update public.work_order_dispatch set
      assignment_status=case when new.vendor_id is not null then 'pending' end,
      instructions=new.dispatch_instructions,
      visit_status='none',visit_start=null,visit_end=null,proposed_by=null,proposed_by_tenant=null,
      field_completed_at=null,completion_notes=null,completion_photos='{}',
      revision=revision+1,updated_at=now() where work_order_id=new.id;
    if previous_worker is not null and previous_worker is distinct from auth.uid()
       and to_regprocedure('public.deliver_inbox_event(uuid,text,text,text,uuid,uuid,uuid,boolean)') is not null then
      perform public.deliver_inbox_event(previous_worker,'Assignment withdrawn',
        'A job is no longer assigned to you.','/contractor',new.property_id,null::uuid,null::uuid,true);
    end if;
  end if;
  if changed_vendor and (tg_op='UPDATE' or new.vendor_id is not null) then
    action:=case when new.vendor_id is null then 'unassigned' when tg_op='UPDATE' and old.vendor_id is not null then 'reassigned' else 'assigned' end;
    perform public.dispatch_record_event(new.id,action,'Repair assignment updated',
      case when new.vendor_id is null then 'A new contractor will be selected.' else 'Open the repair for assignment details.' end);
  end if;
  if tg_op='UPDATE' and not changed_vendor and new.dispatch_instructions is distinct from old.dispatch_instructions then
    update public.work_order_dispatch set instructions=new.dispatch_instructions,revision=revision+1,updated_at=now()
      where work_order_id=new.id;
    perform public.dispatch_record_event(new.id,'instructions_updated','Job instructions updated','Review the current instructions.');
  end if;
  if tg_op='UPDATE' and old.status is distinct from new.status then
    if new.status in ('completed','cancelled') then
      update public.work_order_dispatch set
        assignment_status=case when new.status='completed' and new.vendor_id is not null then 'completed' else assignment_status end,
        revision=revision+1,updated_at=now() where work_order_id=new.id;
      perform public.dispatch_record_event(new.id,case new.status when 'completed' then 'cost_completed' else 'cancelled' end,
        'Work order '||new.status,'The owner updated the job.',array['worker']);
    elsif old.status in ('completed','cancelled') or exists(select from public.work_order_dispatch
          where work_order_id=new.id and assignment_status='completed') then
      perform public.dispatch_record_event(new.id,'reopened','Repair reopened','The repair needs more work.',
        array['worker','management'],jsonb_build_object('prior_ratings',(
          select coalesce(jsonb_agg(jsonb_build_object('request_id',r.id,'rating',r.rating,'comment',r.rating_comment)),'[]'::jsonb)
          from public.maintenance_requests r where r.work_order_id=new.id and r.rating is not null)));
      update public.work_order_dispatch set assignment_status=case when new.vendor_id is not null then 'accepted' end,
        visit_status='none',visit_start=null,visit_end=null,proposed_by=null,proposed_by_tenant=null,
        completion_notes=null,completion_photos='{}',field_completed_at=null,revision=revision+1,updated_at=now()
        where work_order_id=new.id;
      update public.maintenance_requests r set
        status=case when new.status='in_progress' then 'in_progress'::public.request_status else 'acknowledged'::public.request_status end,
        resolved_at=null,rating=null,rating_comment=null
        where r.work_order_id=new.id and r.owner_id=new.owner_id and r.status in ('resolved','closed');
    end if;
  end if;
  return new;
end;
$$;
revoke all on function rentview_private.track_dispatch_order() from public,anon,authenticated;
create trigger record_dispatch_order after insert or update of vendor_id,dispatch_instructions,status on public.work_orders
  for each row execute function rentview_private.track_dispatch_order();

create function public.assign_dispatch(p_work_order uuid,p_vendor uuid,p_instructions text default null) returns void
language plpgsql security definer set search_path='' as $$
declare
  w public.work_orders%rowtype;
  notes text:=nullif(trim(p_instructions),'');
begin
  if not public.current_account_is_active() then raise exception 'Sign in again'; end if;
  select * into w from public.work_orders where id=p_work_order for update;
  if not found or not public.manages_owned_property(w.property_id,w.owner_id) then raise exception 'Work order unavailable'; end if;
  if w.status in ('completed','cancelled') or w.completion_expense_id is not null then raise exception 'Work order is finished'; end if;
  if exists(select from public.work_order_dispatch where work_order_id=w.id and assignment_status='completed') then
    raise exception 'Reopen the completed repair before changing its assignment'; end if;
  if length(notes)>4000 then raise exception 'Job instructions are too long'; end if;
  if p_vendor is not null and not exists(select from public.vendors v where v.id=p_vendor and v.owner_id=w.owner_id
    and (v.property_id is null or v.property_id=w.property_id)) then raise exception 'Choose a vendor for this property'; end if;
  if p_vendor is not null and p_vendor=w.vendor_id and exists(select from public.work_order_dispatch
      where work_order_id=w.id and assignment_status='declined') then
    update public.work_order_dispatch set assignment_status='pending',revision=revision+1,updated_at=now()
      where work_order_id=w.id;
    perform public.dispatch_record_event(w.id,'reassigned','New job assignment','Open the job to accept or decline.');
  end if;
  update public.work_orders set vendor_id=p_vendor,dispatch_instructions=case when p_vendor is not null then notes end where id=w.id;
end;
$$;

create function public.act_on_dispatch(p_work_order uuid,p_revision integer,p_action text,
  p_start timestamptz default null,p_end timestamptz default null,p_notes text default null,p_photos text[] default '{}')
returns void language plpgsql security definer set search_path='' as $$
declare
  w public.work_orders%rowtype;
  d public.work_order_dispatch%rowtype;
  management boolean;
  worker boolean;
  resident boolean;
  linked boolean;
  event_name text;
  event_title text;
  target_groups text[]:=array['management','tenant','worker'];
  notes text:=nullif(trim(p_notes),'');
  photos text[]:=coalesce(p_photos,'{}');
begin
  if not public.current_account_is_active() then raise exception 'Sign in again'; end if;
  select * into w from public.work_orders where id=p_work_order for update;
  if not found then raise exception 'Job unavailable'; end if;
  select * into strict d from public.work_order_dispatch where work_order_id=w.id for update;
  management:=public.manages_owned_property(w.property_id,w.owner_id);
  worker:=public.is_assigned_contractor(w.id,auth.uid());
  select count(*)>0,coalesce(bool_or(r.tenant_user_id=auth.uid() and public.can_access_request(r.id)),false)
    into linked,resident from public.maintenance_requests r
    where r.work_order_id=w.id and r.owner_id=w.owner_id and r.property_id=w.property_id and r.unit_id=w.unit_id;
  if not (management or worker or resident) then raise exception 'Job unavailable'; end if;
  if w.vendor_id is null or w.status in ('completed','cancelled') or w.completion_expense_id is not null then raise exception 'Job is not active'; end if;
  if d.revision is distinct from p_revision then raise exception 'The job changed. Reload and try again.' using errcode='40001'; end if;
  case p_action
    when 'accept','decline' then
      if not worker or d.assignment_status<>'pending' then raise exception 'This offer is no longer pending'; end if;
      event_name:=case p_action when 'accept' then 'accepted' else 'declined' end;
      event_title:=case p_action when 'accept' then 'Contractor accepted the repair' else 'Contractor declined the repair' end;
      update public.work_order_dispatch set assignment_status=event_name where work_order_id=w.id;
    when 'propose' then
      if d.assignment_status<>'accepted' then raise exception 'The contractor must accept the repair first'; end if;
      if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end)
         or p_start<=now() or p_end<=p_start then raise exception 'Choose a future visit start and later finish'; end if;
      event_name:=case d.visit_status when 'none' then 'visit_proposed' else 'visit_rescheduled' end;
      event_title:=case d.visit_status when 'none' then 'Visit proposed' else 'New visit time proposed' end;
      update public.work_order_dispatch set visit_status='proposed',visit_start=p_start,visit_end=p_end,
        proposed_by=auth.uid(),proposed_by_tenant=resident where work_order_id=w.id;
    when 'confirm' then
      if not exists(select from public.dispatch_jobs j where j.work_order_id=w.id and j.can_confirm) then
        raise exception 'The other party must confirm the current future visit'; end if;
      event_name:='visit_confirmed'; event_title:='Visit confirmed';
      update public.work_order_dispatch set visit_status='confirmed' where work_order_id=w.id;
    when 'start' then
      if not worker or d.assignment_status<>'accepted' or w.status='in_progress' then raise exception 'Job cannot be started'; end if;
      update public.work_orders set status='in_progress' where id=w.id;
      event_name:='started'; event_title:='Repair started';
      target_groups:=array['management'];
    when 'complete' then
      if not worker or d.assignment_status<>'accepted' or notes is null or length(notes)>4000 then
        raise exception 'An accepted repair and a brief completion note are required'; end if;
      if cardinality(photos)>8 or exists(select from unnest(photos) photo
        where photo is null or split_part(photo,'/',1)<>w.id::text or split_part(photo,'/',2)<>auth.uid()::text
          or photo !~ '^[^/]+/[^/]+/[A-Za-z0-9_.-]+$' or not exists(select from storage.objects o
            where o.bucket_id='dispatch-photos' and o.name=photo and coalesce(nullif(o.owner_id,''),o.owner::text)=auth.uid()::text)) then
        raise exception 'Choose up to eight photos uploaded for this assignment'; end if;
      update public.work_order_dispatch set assignment_status='completed',field_completed_at=now(),
        completion_notes=notes,completion_photos=photos where work_order_id=w.id;
      -- Field completion resolves the resident's issue. The work order stays available
      -- for the separate, idempotent cost-posting workflow.
      update public.maintenance_requests set status='resolved',resolved_at=now()
        where work_order_id=w.id and owner_id=w.owner_id and status not in ('resolved','closed');
      event_name:='field_completed'; event_title:='Contractor marked the repair complete';
      target_groups:=array['management'];
    when 'reopen' then
      if not management or d.assignment_status<>'completed' then raise exception 'Open a completed field repair to reopen it'; end if;
      perform public.dispatch_record_event(w.id,'reopened','Field repair reopened','Further work is required.',
        target_groups,jsonb_build_object('reason',notes,'prior_ratings',(
          select coalesce(jsonb_agg(jsonb_build_object('request_id',r.id,'rating',r.rating,'comment',r.rating_comment)),'[]'::jsonb)
          from public.maintenance_requests r where r.work_order_id=w.id and r.rating is not null)));
      update public.work_order_dispatch set assignment_status='accepted',field_completed_at=null,
        completion_notes=null,completion_photos='{}',visit_status='none',visit_start=null,visit_end=null,
        proposed_by=null,proposed_by_tenant=null where work_order_id=w.id;
      update public.maintenance_requests set status='acknowledged',resolved_at=null,rating=null,rating_comment=null
        where work_order_id=w.id and owner_id=w.owner_id and status in ('resolved','closed');
    else raise exception 'Unknown dispatch action';
  end case;
  update public.work_order_dispatch set revision=revision+1,updated_at=now() where work_order_id=w.id;
  if event_name is not null then perform public.dispatch_record_event(w.id,event_name,event_title,'Open the repair for details.',target_groups); end if;
end;
$$;

-- Preserve the current reopen behavior: posted/terminal jobs remain history. Reuse an
-- unfinished job and reset its field completion together with the tenant's request.
create or replace function public.reopen_tenant_request(p_request_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare r public.maintenance_requests%rowtype; linked_status public.wo_status;
begin
  select * into r from public.maintenance_requests where id=p_request_id for update;
  if not found or auth.uid() is null or r.tenant_user_id is distinct from auth.uid() or not public.can_access_request(r.id)
    then raise exception 'Request not found' using errcode='42501'; end if;
  if length(trim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'Explain what still needs attention' using errcode='23514'; end if;
  if r.status not in ('resolved','closed') then raise exception 'Only resolved or closed requests can be reopened' using errcode='23514'; end if;
  if r.work_order_id is not null then
    if not pg_try_advisory_xact_lock(hashtextextended('work-order-cost:'||r.work_order_id::text,613)) then
      raise exception 'Repair is being updated. Retry reopening shortly.' using errcode='40001'; end if;
    begin
      select status into linked_status from public.work_orders where id=r.work_order_id and owner_id=r.owner_id for update nowait;
    exception when lock_not_available then
      raise exception 'Repair is being updated. Retry reopening shortly.' using errcode='40001';
    end;
    perform public.dispatch_record_event(r.work_order_id,'reopened','Resident reopened the repair',
      'The tenant reported that the issue persists.',array['worker'],
      jsonb_build_object('request_id',r.id,'prior_rating',r.rating,'prior_rating_comment',r.rating_comment,'reason',trim(p_reason)));
    if linked_status not in ('completed','cancelled') then
      update public.work_order_dispatch set assignment_status='accepted',field_completed_at=null,
        completion_notes=null,completion_photos='{}',visit_status='none',visit_start=null,visit_end=null,
        proposed_by=null,proposed_by_tenant=null,revision=revision+1,updated_at=now()
      where work_order_id=r.work_order_id and assignment_status='completed';
    end if;
  else
    insert into public.dispatch_history(property_id,owner_id,actor_id,event,detail)
      values(r.property_id,r.owner_id,auth.uid(),'reopened',jsonb_build_object('request_id',r.id,'title',r.title,
             'prior_rating',r.rating,'prior_rating_comment',r.rating_comment,'reason',trim(p_reason)));
  end if;
  update public.maintenance_requests set
    status=case when linked_status is not null and linked_status not in ('completed','cancelled') then 'acknowledged'::public.request_status else 'submitted'::public.request_status end,
    work_order_id=case when linked_status is not null and linked_status not in ('completed','cancelled') then r.work_order_id end,
    resolved_at=null,rating=null,rating_comment=null where id=r.id;
  insert into public.request_messages(request_id,sender_id,body) values(r.id,auth.uid(),'Still not fixed: '||trim(p_reason));
end;
$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('dispatch-photos','dispatch-photos',false,10485760,array['image/jpeg','image/png','image/webp','image/heic','image/heif','image/gif']);

-- Storage authorizes object bytes independently of the UI and each recipient's
-- metadata projection. A tenant sees submitted photos only, never a staged upload.
create function rentview_private.dispatch_photo_allowed(p_path text,p_write boolean)
returns boolean language sql stable security definer set search_path='' as $$
  select public.current_account_is_active() and p_path ~ '^[A-Za-z0-9-]+/[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$'
    and split_part(p_path,'/',3) not in ('.','..') and exists(
    select 1 from public.work_orders w join public.work_order_dispatch d on d.work_order_id=w.id
    where w.id::text=split_part(p_path,'/',1)
    and case when p_write then
      public.is_assigned_contractor(w.id,auth.uid()) and d.assignment_status='accepted'
        and w.status not in ('cancelled','completed') and split_part(p_path,'/',2)=auth.uid()::text
    else
      (split_part(p_path,'/',2)=auth.uid()::text and public.is_assigned_contractor(w.id,auth.uid()))
      or (p_path=any(d.completion_photos) and exists(select from public.dispatch_jobs j where j.work_order_id=w.id))
      or (public.can_manage_property(w.property_id) and exists(select from public.dispatch_history h
        where h.work_order_id=w.id and h.detail->'completion_photos' ? p_path))
    end);
$$;
revoke all on function rentview_private.dispatch_photo_allowed(text,boolean) from public,anon,authenticated;
grant execute on function rentview_private.dispatch_photo_allowed(text,boolean) to authenticated;
create policy dispatch_photo_insert on storage.objects for insert to authenticated
  with check(bucket_id='dispatch-photos' and rentview_private.dispatch_photo_allowed(name,true));
create policy dispatch_photo_read on storage.objects for select to authenticated
  using(bucket_id='dispatch-photos' and rentview_private.dispatch_photo_allowed(name,false));

revoke all on function public.my_dispatch_jobs(), public.create_contractor_invite(uuid), public.claim_contractor_invite(text),
  public.assign_dispatch(uuid,uuid,text), public.act_on_dispatch(uuid,integer,text,timestamptz,timestamptz,text,text[])
  from public,anon,authenticated;
grant execute on function public.my_dispatch_jobs(), public.create_contractor_invite(uuid), public.claim_contractor_invite(text),
  public.assign_dispatch(uuid,uuid,text), public.act_on_dispatch(uuid,integer,text,timestamptz,timestamptz,text,text[])
  to authenticated;

-- Changing the verified contact must not silently route new assignments to the
-- old login. A replacement contact claims a fresh invite and accepts active jobs.
create function rentview_private.reset_contractor_contact() returns trigger
language plpgsql security definer set search_path='' as $$
declare previous_worker uuid; job record;
begin
  if lower(trim(new.email)) is not distinct from lower(trim(old.email)) then return new; end if;
  delete from public.contractor_invites where vendor_id=new.id;
  delete from public.contractor_accounts where vendor_id=new.id returning user_id into previous_worker;
  if previous_worker is null then return new; end if;
  for job in select w.id,w.property_id from public.work_orders w
    join public.work_order_dispatch d on d.work_order_id=w.id
    where w.vendor_id=new.id and w.owner_id=new.owner_id and w.status not in ('completed','cancelled')
      and d.assignment_status in ('accepted','pending') for update of w
  loop
    if to_regprocedure('public.deliver_inbox_event(uuid,text,text,text,uuid,uuid,uuid,boolean)') is not null then
      perform public.deliver_inbox_event(previous_worker,'Assignment withdrawn','Your job list changed.',
        '/contractor',job.property_id,null::uuid,null::uuid,true);
    end if;
    update public.work_order_dispatch set assignment_status='pending',visit_status='none',
      visit_start=null,visit_end=null,proposed_by=null,proposed_by_tenant=null,
      revision=revision+1,updated_at=now() where work_order_id=job.id;
    perform public.dispatch_record_event(job.id,'contact_changed','Contractor contact changed',
      'The replacement contractor must accept the repair.',array['management','tenant']);
  end loop;
  return new;
end;
$$;
revoke all on function rentview_private.reset_contractor_contact() from public,anon,authenticated;
create trigger reset_contractor_contact after update of email on public.vendors
  for each row execute function rentview_private.reset_contractor_contact();
