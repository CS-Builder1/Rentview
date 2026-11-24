-- A photo starts as a contractor-owned draft. Once the contractor submits it,
-- the property owns the storage object and keeps it across reassignment and handover.
create table rentview_private.dispatch_evidence (
  name text primary key,
  property_id uuid not null references public.properties(id) on delete cascade,
  work_order_id uuid not null,
  published_by uuid not null,
  published_at timestamptz not null
);
create index dispatch_evidence_property on rentview_private.dispatch_evidence(property_id);
alter table rentview_private.dispatch_evidence enable row level security;
revoke all on rentview_private.dispatch_evidence from public,anon,authenticated,service_role;

create function rentview_private.publish_dispatch_evidence() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  portfolio_owner uuid;
  identity_to_lock uuid;
  photo text;
begin
  if new.work_order_id is null or new.actor_id is null then raise exception 'Missing completion identity'; end if;
  select p.owner_id into strict portfolio_owner from public.properties p where p.id=new.property_id for share;
  -- Deletion prepares its Storage batches under this same identity lock. A claim
  -- must finish before cleanup starts; it cannot take a path from an active batch.
  for identity_to_lock in select distinct i from unnest(array[new.actor_id,portfolio_owner]) i order by i loop
    perform pg_advisory_xact_lock(hashtextextended('billing-owner:'||identity_to_lock::text,0));
  end loop;
  if exists(select from public.account_deletion_requests where owner_id in (portfolio_owner,new.actor_id)) then
    raise exception 'Account deletion is in progress';
  end if;
  for photo in select distinct jsonb_array_elements_text(new.detail->'completion_photos') loop
    if split_part(photo,'/',1)<>new.work_order_id::text or split_part(photo,'/',2)<>new.actor_id::text then
      raise exception 'Invalid completion photo';
    end if;
    update storage.objects set owner=portfolio_owner,owner_id=portfolio_owner::text
      where bucket_id='dispatch-photos' and name=photo
        and coalesce(nullif(owner_id,''),owner::text)=new.actor_id::text;
    if not found then raise exception 'Completion photo unavailable'; end if;
    insert into rentview_private.dispatch_evidence(name,property_id,work_order_id,published_by,published_at)
      values(photo,new.property_id,new.work_order_id,new.actor_id,new.created_at);
  end loop;
  return new;
end $$;
revoke all on function rentview_private.publish_dispatch_evidence() from public,anon,authenticated,service_role;
create trigger publish_dispatch_evidence after insert on public.dispatch_history for each row
  when (new.event='field_completed' and jsonb_array_length(new.detail->'completion_photos')>0)
  execute function rentview_private.publish_dispatch_evidence();

-- Adopt existing, verifiable published objects by the current property owner.
-- A missing object is never reserved for some future upload at the same path.
insert into rentview_private.dispatch_evidence(name,property_id,work_order_id,published_by,published_at)
  select distinct on (photo.name) photo.name,h.property_id,h.work_order_id,h.actor_id,h.created_at
  from public.dispatch_history h
  join public.properties p on p.id=h.property_id
  cross join lateral jsonb_array_elements_text(h.detail->'completion_photos') photo(name)
  join storage.objects o on o.bucket_id='dispatch-photos' and o.name=photo.name
  where h.event='field_completed' and split_part(photo.name,'/',1)=h.work_order_id::text
    and split_part(photo.name,'/',2)=h.actor_id::text
    and coalesce(nullif(o.owner_id,''),o.owner::text) in (h.actor_id::text,p.owner_id::text)
  order by photo.name,h.created_at,h.id;
do $$
declare identity_to_lock uuid;
begin
  for identity_to_lock in
    select e.published_by as id from rentview_private.dispatch_evidence e union
    select p.owner_id from rentview_private.dispatch_evidence e join public.properties p on p.id=e.property_id order by id
  loop
    perform pg_advisory_xact_lock(hashtextextended('billing-owner:'||identity_to_lock::text,0));
  end loop;
  if exists(select from rentview_private.dispatch_evidence e
    join storage.objects o on o.bucket_id='dispatch-photos' and o.name=e.name
    join public.properties p on p.id=e.property_id
    join public.account_deletion_requests a on a.owner_id in (e.published_by,p.owner_id)
    where coalesce(nullif(o.owner_id,''),o.owner::text) is distinct from p.owner_id::text) then
    raise exception 'Finish pending identity deletion before migrating published dispatch photos';
  end if;
end $$;
update storage.objects o set owner=p.owner_id,owner_id=p.owner_id::text
  from rentview_private.dispatch_evidence e join public.properties p on p.id=e.property_id
  where o.bucket_id='dispatch-photos' and o.name=e.name and coalesce(nullif(o.owner_id,''),o.owner::text)=e.published_by::text;

create function rentview_private.transfer_dispatch_evidence() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update storage.objects o set owner=new.owner_id,owner_id=new.owner_id::text
    from rentview_private.dispatch_evidence e
    where e.property_id=new.id and o.bucket_id='dispatch-photos' and o.name=e.name
      and coalesce(nullif(o.owner_id,''),o.owner::text)=old.owner_id::text;
  return new;
end $$;
revoke all on function rentview_private.transfer_dispatch_evidence() from public,anon,authenticated,service_role;
create trigger transfer_dispatch_evidence after update of owner_id on public.properties for each row
  when (old.owner_id is distinct from new.owner_id) execute function rentview_private.transfer_dispatch_evidence();

-- Managers can read retained historical evidence even after the operational
-- work order is gone. Other participants see a photo while it belongs to their
-- currently visible repair. Unpublished bytes are restricted to the uploader.
create or replace function rentview_private.dispatch_photo_allowed(p_path text,p_write boolean)
returns boolean language sql stable security definer set search_path='' as $$
  select public.current_account_is_active() and case when p_write then
    p_path ~ '^[a-f0-9-]+/[a-f0-9-]+/[A-Za-z0-9_.-]+$' and split_part(p_path,'/',3) not in ('.','..')
    and split_part(p_path,'/',2)=auth.uid()::text
    and not exists(select from rentview_private.dispatch_evidence e where e.name=p_path)
    and exists(select from public.work_orders w join public.work_order_dispatch d on d.work_order_id=w.id
      where w.id::text=split_part(p_path,'/',1) and public.is_assigned_contractor(w.id,auth.uid())
        and d.assignment_status='accepted' and w.status not in ('completed','cancelled'))
  else exists(select from rentview_private.dispatch_evidence e where e.name=p_path and
    (public.can_manage_property(e.property_id) or exists(select from public.dispatch_jobs j
      where j.work_order_id=e.work_order_id and p_path=any(j.completion_photos))))
  end;
$$;

create function rentview_private.dispatch_draft_allowed(p_path text) returns boolean
language sql stable security definer set search_path='' as $$
  select public.current_account_is_active() and split_part(p_path,'/',2)=auth.uid()::text
    and not exists(select from rentview_private.dispatch_evidence where name=p_path);
$$;
revoke all on function rentview_private.dispatch_draft_allowed(text) from public,anon,authenticated,service_role;
grant execute on function rentview_private.dispatch_draft_allowed(text) to authenticated;

create policy dispatch_draft_read on storage.objects for select to authenticated using (
  bucket_id='dispatch-photos' and coalesce(nullif(owner_id,''),owner::text)=(select auth.uid())::text
    and rentview_private.dispatch_draft_allowed(name)
);
create policy dispatch_draft_remove on storage.objects for delete to authenticated using (
  bucket_id='dispatch-photos' and coalesce(nullif(owner_id,''),owner::text)=(select auth.uid())::text
    and rentview_private.dispatch_draft_allowed(name)
);
