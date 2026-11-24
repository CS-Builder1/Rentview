-- Structured observations belong to a location. Ending a lease leaves the record intact.
create table public.property_history_entries (
  id uuid primary key,
  property_id uuid not null references public.properties on delete cascade,
  unit_id uuid references public.units on delete set null,
  asset_id uuid references public.assets on delete set null,
  lease_id uuid references public.leases on delete set null,
  kind text not null check (kind in ('observation','inspection','water_shutoff','key_handover','other','asset_condition')),
  event_date date not null,
  title text not null check (length(trim(title)) between 1 and 250),
  details text check (length(details) <= 10000),
  observer text not null check (length(trim(observer)) between 1 and 250),
  actor_id uuid references auth.users on delete set null,
  recorded_by text not null,
  phase text check (phase in ('move_in','routine','move_out')),
  rooms jsonb not null default '[]',
  evidence text[] not null default '{}',
  needs_follow_up boolean not null default false,
  resolved_at timestamptz,
  resolved_by text,
  created_at timestamptz not null default now(),
  check ((kind = 'inspection') = (phase is not null))
);
create index history_property_date on public.property_history_entries(property_id,event_date desc);
create index history_unit_date on public.property_history_entries(unit_id,event_date desc) where unit_id is not null;
create index history_asset_date on public.property_history_entries(asset_id,event_date desc) where asset_id is not null;
alter table public.property_history_entries enable row level security;
revoke all on public.property_history_entries from public, anon, authenticated;
grant select on public.property_history_entries to authenticated;
grant all on public.property_history_entries to service_role;
create policy history_staff_read on public.property_history_entries for select to authenticated
  using (public.current_account_is_active() and public.can_manage_property(property_id));

-- Evidence objects are in a property namespace. Access follows the assignment even
-- when the original observer leaves the management team.
create policy history_photo_read on storage.objects for select to authenticated using (
  public.current_account_is_active() and bucket_id='attachments' and split_part(storage.objects.name,'/',1)='history'
  and exists(select from public.properties p where p.id::text=split_part(storage.objects.name,'/',2)
    and public.can_manage_property(p.id))
  and (split_part(storage.objects.name,'/',3)=(select auth.uid())::text or
    exists(select from public.property_history_entries h where h.property_id::text=split_part(storage.objects.name,'/',2)
      and (storage.objects.name=any(h.evidence) or exists(select from jsonb_array_elements(h.rooms) r
        where (r->'evidence') ? storage.objects.name))))
);
create policy history_photo_insert on storage.objects for insert to authenticated with check (
  public.current_account_is_active() and bucket_id='attachments' and split_part(storage.objects.name,'/',1)='history'
  and split_part(storage.objects.name,'/',3)=(select auth.uid())::text
  and split_part(storage.objects.name,'/',4) ~ '^[a-f0-9-]+\.(jpg|png|gif|webp|heic|heif)$'
  and split_part(storage.objects.name,'/',5)=''
  and exists(select from public.properties p where p.id::text=split_part(storage.objects.name,'/',2)
    and public.can_manage_property(p.id))
);
create policy history_unused_photo_delete on storage.objects for delete to authenticated using (
  public.current_account_is_active() and bucket_id='attachments' and split_part(storage.objects.name,'/',1)='history'
  and split_part(storage.objects.name,'/',3)=(select auth.uid())::text
  and exists(select from public.properties p where p.id::text=split_part(storage.objects.name,'/',2)
    and public.can_manage_property(p.id))
  and not exists(select from public.property_history_entries h where h.property_id::text=split_part(storage.objects.name,'/',2)
    and (storage.objects.name=any(h.evidence) or exists(select from jsonb_array_elements(h.rooms) r where (r->'evidence') ? storage.objects.name)))
);

create function public.record_property_history(p_id uuid,p_property uuid,p_unit uuid,p_asset uuid,p_lease uuid,
  p_kind text,p_date date,p_title text,p_details text,p_observer text,p_phase text,p_rooms jsonb,
  p_evidence text[],p_follow_up boolean)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  actor uuid := auth.uid();
  recorder text;
  portfolio_owner uuid;
  entry public.property_history_entries%rowtype;
  room jsonb;
  path text;
  paths text[] := p_evidence;
begin
  if actor is null or not public.current_account_is_active() or not public.can_manage_property(p_property) then
    raise exception 'Property access is required' using errcode='42501';
  end if;
  select owner_id into strict portfolio_owner from public.properties where id=p_property for share;
  if (p_unit is not null and not exists(select from public.units where id=p_unit and property_id=p_property)) or
     (p_asset is not null and not exists(select from public.assets where id=p_asset and property_id=p_property and unit_id is not distinct from p_unit)) or
     (p_lease is not null and not exists(select from public.leases where id=p_lease and unit_id=p_unit)) then
    raise exception 'Select a unit, asset and tenancy from the same location' using errcode='23514';
  end if;
  if p_kind not in ('observation','inspection','water_shutoff','key_handover','other') then
    raise exception 'Choose a manual event type' using errcode='23514';
  end if;
  if p_date is null or p_date>current_date+1 then
    raise exception 'Choose an observation date in the past or today' using errcode='23514';
  end if;
  if p_phase in ('move_in','move_out') and p_lease is null then
    raise exception 'Select the tenancy for a move-in or move-out inspection' using errcode='23514';
  end if;
  if jsonb_typeof(p_rooms) is distinct from 'array' or jsonb_array_length(p_rooms)>100
     or (p_kind='inspection') is distinct from (jsonb_array_length(p_rooms)>0)
     or p_evidence is null or cardinality(p_evidence)>10 then
    raise exception 'Invalid rooms or evidence' using errcode='23514';
  end if;
  for room in select value from jsonb_array_elements(p_rooms) loop
    if jsonb_typeof(room->'room') is distinct from 'string' or jsonb_typeof(room->'notes') is distinct from 'string'
       or jsonb_typeof(room->'condition') is distinct from 'string'
       or coalesce(length(trim(room->>'room')),0) not between 1 and 120
       or coalesce(room->>'condition','') not in ('good','worn','damaged','missing','not_inspected')
       or coalesce(length(room->>'notes'),0)>2000 or jsonb_typeof(room->'evidence') is distinct from 'array'
       or jsonb_array_length(room->'evidence')>10 then
      raise exception 'Invalid room observation' using errcode='23514';
    end if;
    paths := paths || array(select jsonb_array_elements_text(room->'evidence'));
  end loop;
  if (select count(distinct lower(trim(r->>'room'))) from jsonb_array_elements(p_rooms) r) <> jsonb_array_length(p_rooms) then
    raise exception 'List each room only once' using errcode='23514';
  end if;
  foreach path in array paths loop
    if path is null or path not like ('history/'||p_property||'/'||actor||'/%')
      or not exists(select from storage.objects o where o.bucket_id='attachments' and o.name=path) then
      raise exception 'A selected photo is unavailable for this location' using errcode='23514';
    end if;
  end loop;
  select coalesce(nullif(trim(pr.full_name),''),u.email,actor::text) into recorder from auth.users u
    left join public.profiles pr on pr.id=u.id where u.id=actor;
  insert into public.property_history_entries(id,property_id,unit_id,asset_id,lease_id,kind,event_date,title,details,
    observer,actor_id,recorded_by,phase,rooms,evidence,needs_follow_up)
  values (p_id,p_property,p_unit,p_asset,p_lease,p_kind,p_date,trim(p_title),nullif(trim(p_details),''),
    coalesce(nullif(trim(p_observer),''),left(recorder,250)),actor,recorder,p_phase,p_rooms,p_evidence,p_follow_up)
  on conflict (id) do nothing;
  if not found then
    select * into entry from public.property_history_entries where id=p_id;
    if row(entry.actor_id,entry.property_id,entry.unit_id,entry.asset_id,entry.lease_id,entry.kind,entry.event_date,
           entry.title,entry.details,entry.observer,entry.phase,entry.rooms,entry.evidence,entry.needs_follow_up)
       is distinct from row(actor,p_property,p_unit,p_asset,p_lease,p_kind,p_date,trim(p_title),nullif(trim(p_details),''),
           coalesce(nullif(trim(p_observer),''),left(entry.recorded_by,250)),p_phase,p_rooms,p_evidence,p_follow_up) then
      raise exception 'This entry was already saved with different details' using errcode='23505';
    end if;
  end if;
  -- A departing staff account can be removed without purging the property's
  -- saved evidence. Unsaved drafts still belong to their uploader.
  if cardinality(paths)>0 then
    update storage.objects set owner=portfolio_owner,owner_id=portfolio_owner::text
      where bucket_id='attachments' and name=any(paths) and owner_id is distinct from portfolio_owner::text;
  end if;
  return p_id;
end $$;
create function public.resolve_property_history(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare e public.property_history_entries%rowtype;
begin
  select * into e from public.property_history_entries where id=p_id for update;
  if not found or not public.current_account_is_active() or not public.can_manage_property(e.property_id) then
    raise exception 'Property access is required' using errcode='42501';
  end if;
  update public.property_history_entries set resolved_at=now(),
    resolved_by=coalesce(nullif((select full_name from public.profiles where id=auth.uid()),''),
                         (select email from auth.users where id=auth.uid()),auth.uid()::text)
    where id=p_id and needs_follow_up and resolved_at is null;
end $$;
revoke all on function public.record_property_history(uuid,uuid,uuid,uuid,uuid,text,date,text,text,text,text,jsonb,text[],boolean),
  public.resolve_property_history(uuid) from public,anon,authenticated;
grant execute on function public.record_property_history(uuid,uuid,uuid,uuid,uuid,text,date,text,text,text,text,jsonb,text[],boolean),
  public.resolve_property_history(uuid) to authenticated;

-- Preserve changes made through the ordinary asset editor as well as inspections.
create function rentview_private.record_asset_condition() returns trigger
language plpgsql security definer set search_path='' as $$
declare recorder text;
begin
  select coalesce(nullif(trim(pr.full_name),''),u.email,u.id::text) into recorder
    from auth.users u left join public.profiles pr on pr.id=u.id where u.id=auth.uid();
  insert into public.property_history_entries(id,property_id,unit_id,asset_id,kind,event_date,title,details,observer,actor_id,recorded_by)
  values(gen_random_uuid(),new.property_id,new.unit_id,new.id,'asset_condition',current_date,left(new.name,220)||' · condition changed',
    replace(old.status::text,'_',' ')||' → '||replace(new.status::text,'_',' '),
    left(coalesce(recorder,'System'),250),auth.uid(),coalesce(recorder,'System'));
  return new;
end $$;
revoke all on function rentview_private.record_asset_condition() from public,anon,authenticated;
create trigger record_asset_condition after update of status on public.assets
  for each row when (old.status is distinct from new.status)
  execute function rentview_private.record_asset_condition();

create function rentview_private.transfer_history_evidence() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update storage.objects set owner=new.owner_id,owner_id=new.owner_id::text
    where bucket_id='attachments' and name like ('history/'||new.id||'/%') and owner_id=old.owner_id::text
      and exists(select from public.property_history_entries h where h.property_id=new.id
        and (storage.objects.name=any(h.evidence) or exists(select from jsonb_array_elements(h.rooms) r
          where (r->'evidence') ? storage.objects.name)));
  return new;
end $$;
revoke all on function rentview_private.transfer_history_evidence() from public,anon,authenticated;
create trigger transfer_history_evidence after update of owner_id on public.properties
  for each row when (old.owner_id is distinct from new.owner_id)
  execute function rentview_private.transfer_history_evidence();

-- Carry the last known completion from schedules created before completion
-- records existed. Otherwise their first new service would overwrite this date.
insert into public.maintenance_completions(owner_id,schedule_id,property_id,unit_id,asset_id,completed_on,notes,next_due)
select s.owner_id,s.id,s.property_id,s.unit_id,s.asset_id,s.last_done,
  'Latest completion recorded on the original schedule',s.next_due
from public.maintenance_schedules s where s.last_done is not null
on conflict (schedule_id,completed_on) do nothing;

-- One source row appears once at each applicable scope. Historical jobs created
-- before event logging began still have their own original date and cost.
create view public.property_event_history with (security_invoker=true) as
with events(id,kind,property_id,unit_id,asset_id,lease_id,job_id,request_id,manual_id,expected_owner,
           event_date,event_time,title,details,evidence,unresolved,amount,currency) as (
  select 'entry:'||h.id,h.kind,h.property_id,h.unit_id,h.asset_id,h.lease_id,null::uuid,null::uuid,h.id,null::uuid,
    h.event_date,case when h.kind='asset_condition' then h.created_at end,h.title,h.details,h.evidence,h.needs_follow_up and h.resolved_at is null,
    null::numeric,null::text from public.property_history_entries h
  union all
  select 'resolved:'||h.id,'follow_up',h.property_id,h.unit_id,h.asset_id,h.lease_id,null,null,h.id,null,
    h.resolved_at::date,h.resolved_at,'Resolved: '||h.title,h.resolved_by,'{}',false,null,null
    from public.property_history_entries h where h.resolved_at is not null
  union all
  select 'job:'||w.id,'work_order',w.property_id,w.unit_id,w.asset_id,null,w.id,null,null,w.owner_id,
    coalesce(w.completed_at,w.created_at)::date,coalesce(w.completed_at,w.created_at),w.title,
    concat_ws(' · ',replace(w.status::text,'_',' '),v.name,w.description),'{}',
    w.status not in ('completed','cancelled'),w.cost,w.cost_currency
    from public.work_orders w left join public.vendors v on v.id=w.vendor_id and v.owner_id=w.owner_id
  union all
  select 'status:'||e.id,'job_update',w.property_id,w.unit_id,coalesce(e.asset_id,w.asset_id),null,w.id,null,null,e.owner_id,
    e.created_at::date,e.created_at,coalesce(e.summary,w.title),replace(e.data->>'status','_',' '),'{}',false,null,null
    from public.work_order_events e join public.work_orders w on w.id=e.work_order_id and w.owner_id=e.owner_id
    where e.event_type='status_changed' and (e.data->>'status' <> 'completed' or w.completed_at is null)
  union all
  select 'expense:'||e.id,'expense',e.property_id,coalesce(e.unit_id,w.unit_id),w.asset_id,null,w.id,null,null,e.owner_id,
    e.incurred_on,null,coalesce(nullif(e.description,''),initcap(e.category::text)),
    concat_ws(' · ',v.name,w.title),'{}',false,e.amount,e.currency
    from public.expenses e left join public.work_orders w on w.id=e.work_order_id
      and w.property_id=e.property_id and w.owner_id=e.owner_id
    left join public.vendors v on v.id=e.vendor_id and v.owner_id=e.owner_id
  union all
  select 'part:'||pt.id,'part',w.property_id,w.unit_id,w.asset_id,null,w.id,null,null,w.owner_id,
    pt.created_at::date,pt.created_at,coalesce(pt.description,i.name,'Part'),concat_ws(' · ',w.title,
      'Quantity '||pt.quantity,case when pt.removed_at is not null then 'Removed '||pt.removed_at::date end),
    '{}',false,pt.quantity*pt.unit_cost,pt.cost_currency
    from public.work_order_parts pt join public.work_orders w on w.id=pt.work_order_id and w.owner_id=pt.owner_id
    left join public.inventory_items i on i.id=pt.inventory_item_id and i.owner_id=pt.owner_id
  union all
  select 'request:'||r.id,'request',r.property_id,r.unit_id,w.asset_id,r.lease_id,w.id,r.id,null,r.owner_id,
    r.created_at::date,r.created_at,r.title,concat_ws(' · ',r.status::text,r.description),
    '{}',
    r.status not in ('resolved','closed'),null,null
    from public.maintenance_requests r left join public.work_orders w on w.id=r.work_order_id
      and w.property_id=r.property_id and w.owner_id=r.owner_id
  union all
  select 'request-photo:'||rp.id,'request_photo',r.property_id,r.unit_id,w.asset_id,r.lease_id,w.id,r.id,null,r.owner_id,
    rp.created_at::date,rp.created_at,r.title||' · photo',null,array[rp.storage_path],false,null,null
    from public.request_photos rp join public.maintenance_requests r on r.id=rp.request_id
    left join public.work_orders w on w.id=r.work_order_id and w.property_id=r.property_id and w.owner_id=r.owner_id
  union all
  select 'service:'||c.id,'maintenance',c.property_id,c.unit_id,c.asset_id,null,null,null,null,c.owner_id,
    c.completed_on,null,coalesce(s.title,'Completed service'),c.notes,'{}',false,null,null
    from public.maintenance_completions c left join public.maintenance_schedules s on s.id=c.schedule_id and s.owner_id=c.owner_id
  union all
  select 'legacy-service:'||s.id,'maintenance',s.property_id,s.unit_id,s.asset_id,null,null,null,null,s.owner_id,
    s.last_done,null,s.title,'Latest completion recorded on the original schedule','{}',false,null,null
    from public.maintenance_schedules s where s.last_done is not null
      and not exists(select from public.maintenance_completions c where c.schedule_id=s.id and c.completed_on=s.last_done)
  union all
  select 'document:'||d.id,'document',d.property_id,coalesce(d.unit_id,w.unit_id),coalesce(d.asset_id,w.asset_id),
    null,w.id,null,null,d.owner_id,d.created_at::date,d.created_at,d.name,d.doc_type::text,array[d.storage_path],false,null,null
    from public.documents d left join public.work_orders w on w.id=d.work_order_id and w.property_id=d.property_id and w.owner_id=d.owner_id
  union all
  select 'visit:'||d.id,'dispatch',d.property_id,coalesce((d.detail->>'unit_id')::uuid,w.unit_id),
    coalesce((d.detail->>'asset_id')::uuid,w.asset_id),null,w.id,null,null,null,
    d.created_at::date,d.created_at,initcap(replace(d.event,'_',' '))||' · '||coalesce(d.detail->>'title',w.title,'Work order'),
    concat_ws(E'\n',coalesce(d.detail->>'vendor_name',v.name),case when d.detail->>'visit_start' is not null then
      'Visit window: '||(d.detail->>'visit_start')||' – '||(d.detail->>'visit_end') end,
      case when d.event='field_completed' then d.detail->>'completion_notes' end),
    case when d.event='field_completed' then array(select jsonb_array_elements_text(coalesce(nullif(d.detail->'completion_photos','null'::jsonb),'[]'::jsonb))) else '{}' end,
    false,null,null
    from public.dispatch_history d left join public.work_orders w on w.id=d.work_order_id and w.property_id=d.property_id
    left join public.vendors v on v.id::text=d.detail->>'vendor_id' and v.owner_id=coalesce(w.owner_id,d.owner_id)
    where d.work_order_id is not null
  union all
  select 'installed:'||a.id,'asset_installation',a.property_id,a.unit_id,a.id,null,null,null,null,a.owner_id,
    a.install_date,null,a.name||' installed',concat_ws(' · ',a.make,a.model,a.serial_number),'{}',false,
    a.purchase_cost,a.purchase_currency from public.assets a where a.install_date is not null
)
select e.id,e.kind,e.property_id,e.unit_id,e.asset_id,e.lease_id,e.job_id,e.request_id,e.manual_id,
  e.event_date,e.event_time,e.title,e.details,e.evidence,e.unresolved,e.amount,
  case when e.amount is not null then coalesce(e.currency,p.currency) end currency,
  concat_ws(' · ',p.name,u.label,a.name,l.tenant_name) scope_label,
  case when e.kind='follow_up' then h.resolved_by else h.observer end observer,
  case when e.kind='follow_up' then h.resolved_by else h.recorded_by end recorded_by,
  case when e.kind='inspection' then h.phase end phase,
  case when e.kind='inspection' then h.rooms else '[]'::jsonb end rooms
from events e join public.properties p on p.id=e.property_id and (e.expected_owner is null or p.owner_id=e.expected_owner)
left join public.units u on u.id=e.unit_id and u.property_id=p.id and u.owner_id=p.owner_id
left join public.assets a on a.id=e.asset_id and a.property_id=p.id and a.owner_id=p.owner_id
left join public.leases l on l.id=e.lease_id and l.unit_id=e.unit_id and l.owner_id=p.owner_id
left join public.property_history_entries h on h.id=e.manual_id
where public.current_account_is_active() and public.can_manage_property(p.id);
revoke all on public.property_event_history from public,anon,authenticated;
grant select on public.property_event_history to authenticated;
