-- A lease conversation belongs to one resident's tenancy. Re-linking a lease
-- starts a fresh conversation even when a manager reuses the lease record.
create table public.lease_messages (
  id uuid primary key,
  lease_id uuid not null references public.leases on delete cascade,
  tenant_user_id uuid not null references auth.users on delete cascade,
  sender_id uuid references auth.users on delete set null,
  body text not null check (length(trim(body)) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index lease_messages_thread_idx on public.lease_messages(lease_id,tenant_user_id,created_at desc,id desc);
create index lease_messages_sender_idx on public.lease_messages(sender_id,created_at desc);
create table public.inbox_events (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users on delete cascade,
  property_id uuid not null references public.properties on delete cascade,
  lease_id uuid references public.leases on delete cascade,
  request_id uuid references public.maintenance_requests on delete cascade,
  title text not null,
  body text not null,
  href text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index inbox_events_recipient_idx on public.inbox_events(recipient_id,created_at desc,id desc);
create index inbox_events_unread_idx on public.inbox_events(recipient_id,href) where read_at is null;
alter table public.lease_messages enable row level security;
alter table public.inbox_events enable row level security;
-- All client reads and writes go through the narrow RPCs below. No direct
-- table privileges, including for installations with permissive defaults.
revoke all on public.lease_messages,public.inbox_events from public,anon,authenticated;
grant all on public.lease_messages,public.inbox_events to service_role;

alter table public.notification_outbox drop constraint notification_outbox_event_check;
alter table public.notification_outbox add check (event in
  ('request_created','request_updated','request_message','announcement','inbox_event'));

create function public.deliver_inbox_event(
  p_recipient uuid,p_title text,p_body text,p_href text,p_property uuid,
  p_lease uuid default null,p_request uuid default null,p_push boolean default true
) returns void language plpgsql security definer set search_path='' as $$
declare event_id uuid;
begin
  if p_recipient is null then return; end if;
  if p_href='/contractor' then
    p_title:='Assignment withdrawn'; p_body:='Open your work list to see current assignments.';
  end if;
  insert into public.inbox_events(recipient_id,title,body,href,property_id,lease_id,request_id)
    values(p_recipient,left(p_title,120),left(p_body,300),p_href,p_property,p_lease,p_request)
    returning id into event_id;
  if p_push then perform public.notify_push('inbox_event',event_id,auth.uid()); end if;
end $$;
revoke all on function public.deliver_inbox_event(uuid,text,text,text,uuid,uuid,uuid,boolean) from public,anon,authenticated;

-- Recheck the current relationship both on inbox reads and when a delayed
-- outbox job is delivered. A recipient ID alone must never grant continued access.
create function rentview_private.inbox_event_visible(e public.inbox_events)
returns boolean language sql stable security definer set search_path='' as $$
  select not exists(select 1 from public.account_deletion_requests d where d.owner_id=e.recipient_id)
    and case when e.href='/contractor' then true when e.href like '/contractor/job/%' then
      public.is_assigned_contractor(substr(e.href,length('/contractor/job/')+1)::uuid,e.recipient_id)
    else exists(select 1 from public.properties p where p.id=e.property_id and p.owner_id=e.recipient_id)
      or exists(select 1 from public.property_managers m where m.property_id=e.property_id and m.user_id=e.recipient_id)
      or exists(select 1 from public.leases l join public.units u on u.id=l.unit_id
        where l.id=e.lease_id and l.tenant_user_id=e.recipient_id and u.property_id=e.property_id
          and public.lease_is_current(l)
          and (e.request_id is null or exists(select 1 from public.maintenance_requests r
            where r.id=e.request_id and r.lease_id=l.id and r.tenant_user_id=e.recipient_id)))
    end;
$$;
revoke all on function rentview_private.inbox_event_visible(public.inbox_events) from public,anon,authenticated;

create function public.inbox_delivery(p_event uuid)
returns table(recipient_id uuid,title text,body text,href text,preference text)
language sql stable security definer set search_path='' as $$
  select e.recipient_id,e.title,e.body,e.href,
    case when e.href like '/conversation/%' then 'messages' else 'requests' end
    from public.inbox_events e where e.id=p_event and rentview_private.inbox_event_visible(e);
$$;
revoke all on function public.inbox_delivery(uuid) from public,anon,authenticated;
grant execute on function public.inbox_delivery(uuid) to service_role;

create function public.inbox_activity()
returns table(id uuid,title text,body text,href text,created_at timestamptz,read_at timestamptz)
language sql stable security definer set search_path='' as $$
  select e.id,e.title,e.body,e.href,e.created_at,e.read_at from public.inbox_events e
    where e.recipient_id=(select auth.uid()) and rentview_private.inbox_event_visible(e)
    order by e.created_at desc,e.id desc;
$$;
create function public.inbox_unread_count()
returns bigint language sql stable security definer set search_path='' as $$
  select count(*) from public.inbox_events e where e.recipient_id=(select auth.uid())
    and e.read_at is null and rentview_private.inbox_event_visible(e);
$$;
create function public.unread_repair_replies()
returns table(request_id uuid,latest_at timestamptz)
language sql stable security definer set search_path='' as $$
  select e.request_id,max(e.created_at) from public.inbox_events e
    where e.recipient_id=(select auth.uid()) and e.read_at is null and e.request_id is not null
      and e.title='Repair reply' and rentview_private.inbox_event_visible(e)
    group by e.request_id;
$$;
create function public.mark_inbox_read(p_id uuid)
returns void language sql security definer set search_path='' as $$
  update public.inbox_events e set read_at=now() where e.id=p_id and e.read_at is null
    and e.recipient_id=(select auth.uid()) and rentview_private.inbox_event_visible(e);
$$;
create function public.mark_thread_read(p_href text,p_through timestamptz)
returns void language sql security definer set search_path='' as $$
  update public.inbox_events e set read_at=now() where e.href=p_href and e.read_at is null
    and e.created_at<=least(p_through,now()) and e.recipient_id=(select auth.uid())
    and rentview_private.inbox_event_visible(e);
$$;

create function public.inbox_leases(p_lease uuid default null)
returns table(lease_id uuid,resident_id uuid,property_name text,unit_label text,contact_name text,
  last_message text,latest_at timestamptz,unread bigint)
language sql stable security definer set search_path='' as $$
  select l.id,l.tenant_user_id,p.name,u.label,
    case when l.tenant_user_id=(select auth.uid()) then coalesce(nullif(pr.full_name,''),'Property management')
      else l.tenant_name end,
    last.body,last.created_at,(select count(*) from public.inbox_events e where e.recipient_id=(select auth.uid())
      and e.lease_id=l.id and e.href='/conversation/'||l.id and e.read_at is null)
    from public.leases l join public.units u on u.id=l.unit_id join public.properties p on p.id=u.property_id
    left join public.profiles pr on pr.id=p.owner_id
    left join lateral (select m.body,m.created_at from public.lease_messages m where m.lease_id=l.id
      and m.tenant_user_id=l.tenant_user_id order by m.created_at desc,m.id desc limit 1) last on true
    where (select public.current_account_is_active()) and (p_lease is null or l.id=p_lease)
      and public.lease_is_current(l) and l.tenant_user_id is not null
      and (l.tenant_user_id=(select auth.uid()) or public.can_manage_property(p.id))
    order by last.created_at desc nulls last,p.name,u.label,l.id;
$$;
create function public.lease_thread(p_lease uuid,p_resident uuid)
returns table(id uuid,body text,sender_id uuid,sender_name text,created_at timestamptz)
language sql stable security definer set search_path='' as $$
  select m.id,m.body,m.sender_id,coalesce(nullif(pr.full_name,''),case when m.sender_id=l.tenant_user_id
    then l.tenant_name else 'Property management' end),m.created_at from public.lease_messages m
    join public.leases l on l.id=m.lease_id and l.tenant_user_id=m.tenant_user_id
    join public.units u on u.id=l.unit_id left join public.profiles pr on pr.id=m.sender_id
    where (select public.current_account_is_active()) and l.id=p_lease and l.tenant_user_id=p_resident
      and public.lease_is_current(l) and (l.tenant_user_id=(select auth.uid()) or public.can_manage_property(u.property_id))
    order by m.created_at desc,m.id desc;
$$;
create function public.send_lease_message(p_lease uuid,p_resident uuid,p_id uuid,p_body text)
returns void language plpgsql security definer set search_path='' as $$
declare l public.leases%rowtype; prop uuid; uid uuid:=auth.uid(); recipient uuid;
begin
  select * into l from public.leases where id=p_lease for share;
  select property_id into prop from public.units where id=l.unit_id;
  if not public.current_account_is_active() or l.id is null or not public.lease_is_current(l)
    or l.tenant_user_id is null or l.tenant_user_id is distinct from p_resident
    or not (l.tenant_user_id=uid or public.can_manage_property(prop))
    then raise exception 'This tenancy is no longer available' using errcode='42501'; end if;
  if length(trim(coalesce(p_body,''))) not between 1 and 5000 then
    raise exception 'Use between 1 and 5,000 characters' using errcode='23514'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text||'lease_messages',612));
  if exists(select 1 from public.lease_messages m where m.id=p_id and m.sender_id=uid
    and m.lease_id=l.id and m.tenant_user_id=p_resident and m.body=trim(p_body)) then return; end if;
  if (select count(*) from public.lease_messages m where m.sender_id=uid and m.created_at>now()-interval '1 minute')>=30
    then raise exception 'Too many messages. Try again in a minute'; end if;
  insert into public.lease_messages(id,lease_id,tenant_user_id,sender_id,body) values(p_id,l.id,p_resident,uid,trim(p_body));
  for recipient in select l.owner_id union select m.user_id from public.property_managers m where m.property_id=prop
    union select p_resident loop
    if recipient<>uid then
      perform public.deliver_inbox_event(recipient,'New lease message',trim(p_body),'/conversation/'||l.id,prop,l.id);
    end if;
  end loop;
end $$;

-- Repair activity also reaches managers' inboxes, even when the repair has
-- already left the open queue. The legacy outbox handles external delivery.
create function rentview_private.inbox_repair_activity()
returns trigger language plpgsql security definer set search_path='' as $$
declare r public.maintenance_requests%rowtype; actor uuid; recipient uuid; subject text; detail text; url text;
begin
  if tg_table_name='request_messages' then
    select * into r from public.maintenance_requests where id=new.request_id;
    actor:=new.sender_id; subject:='Repair reply'; detail:=r.title||' · '||new.body;
  else
    r:=new;
    if tg_op='INSERT' then actor:=r.tenant_user_id; subject:='New repair request'; detail:=r.title;
    else actor:=coalesce(auth.uid(),r.owner_id); subject:='Repair updated'; detail:=r.title||' · '||replace(r.status::text,'_',' '); end if;
  end if;
  for recipient in select r.owner_id union select m.user_id from public.property_managers m where m.property_id=r.property_id
    union select l.tenant_user_id from public.leases l where l.id=r.lease_id and public.lease_is_current(l)
      and l.tenant_user_id=r.tenant_user_id loop
    if recipient is distinct from actor then
      url:=case when recipient=r.tenant_user_id then '/tenant/request/' else '/request/' end||r.id;
      perform public.deliver_inbox_event(recipient,subject,detail,url,r.property_id,r.lease_id,r.id,false);
    end if;
  end loop;
  return null;
end $$;
revoke all on function rentview_private.inbox_repair_activity() from public,anon,authenticated;
create trigger inbox_request_created after insert on public.maintenance_requests for each row execute function rentview_private.inbox_repair_activity();
create trigger inbox_request_status after update of status on public.maintenance_requests for each row when (new.status is distinct from old.status) execute function rentview_private.inbox_repair_activity();
create trigger inbox_request_message after insert on public.request_messages for each row execute function rentview_private.inbox_repair_activity();

create function rentview_private.inbox_announcement()
returns trigger language plpgsql security definer set search_path='' as $$
declare target record;
begin
  for target in select distinct on (l.tenant_user_id) l.tenant_user_id,l.id,u.property_id
    from public.leases l join public.units u on u.id=l.unit_id
    where l.owner_id=new.owner_id and l.tenant_user_id is not null and public.lease_is_current(l)
      and (new.property_id is null or new.property_id=u.property_id) order by l.tenant_user_id,l.id loop
    perform public.deliver_inbox_event(target.tenant_user_id,new.title,coalesce(new.body,''),'/tenant/notices',target.property_id,target.id,null,false);
  end loop;
  return null;
end $$;
revoke all on function rentview_private.inbox_announcement() from public,anon,authenticated;
create trigger inbox_announcement after insert on public.announcements for each row execute function rentview_private.inbox_announcement();

revoke all on function public.inbox_activity(),public.inbox_unread_count(),public.unread_repair_replies(),public.mark_inbox_read(uuid),public.mark_thread_read(text,timestamptz),
  public.inbox_leases(uuid),public.lease_thread(uuid,uuid),public.send_lease_message(uuid,uuid,uuid,text) from public,anon;
grant execute on function public.inbox_activity(),public.inbox_unread_count(),public.unread_repair_replies(),public.mark_inbox_read(uuid),public.mark_thread_read(text,timestamptz),
  public.inbox_leases(uuid),public.lease_thread(uuid,uuid),public.send_lease_message(uuid,uuid,uuid,text) to authenticated;
