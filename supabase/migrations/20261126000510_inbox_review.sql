-- Keep a tenancy's conversation identifier when erasure clears the resident
-- foreign key. A later resident on the same lease receives a separate thread.
create table rentview_private.lease_conversations (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references public.leases on delete cascade,
  resident_id uuid references auth.users on delete set null,
  unique(lease_id,resident_id),
  unique(id,lease_id)
);
create index lease_conversations_resident on rentview_private.lease_conversations(resident_id) where resident_id is not null;
alter table rentview_private.lease_conversations enable row level security;
revoke all on rentview_private.lease_conversations from public,anon,authenticated;
insert into rentview_private.lease_conversations(lease_id,resident_id)
  select lease_id,tenant_user_id from public.lease_messages
  union select id,tenant_user_id from public.leases where tenant_user_id is not null;

alter table public.lease_messages drop constraint lease_messages_tenant_user_id_fkey,
  alter column tenant_user_id drop not null,
  add foreign key(tenant_user_id) references auth.users(id) on delete set null,
  add column conversation_id uuid, add column from_resident boolean;
update public.lease_messages m set conversation_id=c.id,from_resident=(m.sender_id is not null and m.sender_id=m.tenant_user_id)
  from rentview_private.lease_conversations c where c.lease_id=m.lease_id and c.resident_id=m.tenant_user_id;
alter table public.lease_messages alter column conversation_id set not null, alter column from_resident set not null,
  add foreign key(conversation_id,lease_id) references rentview_private.lease_conversations(id,lease_id) on delete cascade;
create index lease_messages_conversation_time on public.lease_messages(conversation_id,created_at desc,id desc);

create function rentview_private.link_lease_conversation() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into rentview_private.lease_conversations(lease_id,resident_id) values(new.id,new.tenant_user_id)
    on conflict(lease_id,resident_id) do nothing;
  return null;
end $$;
revoke all on function rentview_private.link_lease_conversation() from public,anon,authenticated;
create trigger link_lease_conversation after insert or update of tenant_user_id on public.leases for each row
  when (new.tenant_user_id is not null) execute function rentview_private.link_lease_conversation();

create function rentview_private.assign_lease_conversation() returns trigger language plpgsql security definer set search_path='' as $$
begin
  select c.id into strict new.conversation_id from rentview_private.lease_conversations c
    where c.lease_id=new.lease_id and c.resident_id=new.tenant_user_id;
  new.from_resident:=new.sender_id=new.tenant_user_id;
  return new;
end $$;
revoke all on function rentview_private.assign_lease_conversation() from public,anon,authenticated;
create trigger assign_lease_conversation before insert on public.lease_messages for each row
  execute function rentview_private.assign_lease_conversation();

-- Old notices only carry a lease ID. Pin unambiguous notices to the durable
-- thread to keep a historical message from opening against a later resident.
update public.inbox_events e set href=e.href||'?thread='||c.id
from rentview_private.lease_conversations c
where e.lease_id=c.lease_id and e.href='/conversation/'||c.lease_id and not exists(
  select from rentview_private.lease_conversations other where other.lease_id=c.lease_id and other.id<>c.id);

drop function public.inbox_leases(uuid);
create function public.inbox_leases(p_lease uuid default null,p_thread uuid default null)
returns table(lease_id uuid,resident_id uuid,property_name text,unit_label text,contact_name text,
  last_message text,latest_at timestamptz,unread bigint,thread_id uuid,can_post boolean)
language sql stable security definer set search_path='' as $$
  select l.id,c.resident_id,p.name,u.label,case when c.resident_id=(select auth.uid()) then coalesce(nullif(manager.full_name,''),'Property management')
      when c.resident_id is null then 'Former resident'
      when c.resident_id in (l.portal_resident_id,l.tenant_user_id) then l.tenant_name
      else coalesce(nullif(resident.full_name,''),'Former resident') end,
    msg.body,msg.created_at,(select count(*) from public.inbox_events e where e.recipient_id=(select auth.uid())
       and e.href='/conversation/'||l.id||'?thread='||c.id and e.read_at is null),
    c.id,access.current_tenancy
  from rentview_private.lease_conversations c join public.leases l on l.id=c.lease_id
  join public.units u on u.id=l.unit_id and u.owner_id=l.owner_id join public.properties p on p.id=u.property_id and p.owner_id=l.owner_id
  left join public.profiles manager on manager.id=p.owner_id left join public.profiles resident on resident.id=c.resident_id
  cross join lateral (select (l.tenant_user_id=c.resident_id and public.lease_is_current(l)) is true as current_tenancy) access
  left join lateral (select m.body,m.created_at from public.lease_messages m where m.conversation_id=c.id
      order by m.created_at desc,m.id desc limit 1) msg on true
  where (select public.current_account_is_active()) and (p_lease is null or l.id=p_lease) and (p_thread is null or c.id=p_thread)
    and ((access.current_tenancy and c.resident_id=(select auth.uid())) or
      (public.can_manage_property(p.id) and (access.current_tenancy or msg.created_at is not null)))
  order by msg.created_at desc nulls last,p.name,u.label,l.id,c.id;
$$;
drop function public.lease_thread(uuid,uuid);
create function public.lease_thread(p_lease uuid,p_resident uuid,p_thread uuid default null)
returns table(id uuid,body text,sender_id uuid,sender_name text,created_at timestamptz)
language sql stable security definer set search_path='' as $$
  select m.id,m.body,m.sender_id,coalesce(nullif(pr.full_name,''),case when m.from_resident then
      case when c.resident_id is null then 'Former resident' else 'Resident' end else 'Property management' end),m.created_at
  from rentview_private.lease_conversations c join public.lease_messages m on m.conversation_id=c.id
  join public.leases l on l.id=c.lease_id join public.units u on u.id=l.unit_id and u.owner_id=l.owner_id
  left join public.profiles pr on pr.id=m.sender_id
  where (select public.current_account_is_active()) and l.id=p_lease
    and case when p_thread is not null then c.id=p_thread else c.resident_id=p_resident end
    and (public.can_manage_property(u.property_id) or
      (public.lease_is_current(l) and l.tenant_user_id=c.resident_id and c.resident_id=(select auth.uid())))
  order by m.created_at desc,m.id desc;
$$;

create or replace function public.send_lease_message(p_lease uuid,p_resident uuid,p_id uuid,p_body text)
returns void language plpgsql security definer set search_path='' as $$
declare l public.leases%rowtype; prop uuid; uid uuid:=auth.uid(); recipient uuid; thread_id uuid;
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
  insert into public.lease_messages(id,lease_id,tenant_user_id,sender_id,body) values(p_id,l.id,p_resident,uid,trim(p_body)) returning conversation_id into thread_id;
  for recipient in select l.owner_id union select m.user_id from public.property_managers m where m.property_id=prop
    union select p_resident loop
    if recipient<>uid then
      perform public.deliver_inbox_event(recipient,'New lease message',trim(p_body),'/conversation/'||l.id||'?thread='||thread_id,prop,l.id);
    end if;
  end loop;
end $$;

-- Older clients submit the lease-only href. Mark only its current thread;
-- a read receipt for a replacement tenant never consumes a predecessor's mail.
create or replace function public.mark_thread_read(p_href text,p_through timestamptz)
returns void language sql security definer set search_path='' as $$
  update public.inbox_events e set read_at=now() where e.read_at is null
    and e.created_at<=least(p_through,now()) and e.recipient_id=(select auth.uid())
    and (e.href=p_href or exists(select from rentview_private.lease_conversations c join public.leases l on l.id=c.lease_id
      where p_href='/conversation/'||l.id and e.href=p_href||'?thread='||c.id
        and c.resident_id=l.tenant_user_id and public.lease_is_current(l)))
    and rentview_private.inbox_event_visible(e);
$$;

-- Limit candidate reads before running the per-event scope predicate. The
-- next cursor belongs to the raw page so an entirely revoked page never
-- hides earlier visible events. Return only authorized message content.
create function public.inbox_activity(p_before timestamptz,p_before_id uuid,p_limit integer)
returns jsonb language sql stable security definer set search_path='' as $$
  with settings as (select greatest(1,least(coalesce(p_limit,30),100)) n),
  candidates as materialized (
    select e.* from public.inbox_events e where e.recipient_id=(select auth.uid())
      and ((p_before is null and p_before_id is null) or (e.created_at,e.id)<(p_before,p_before_id))
      order by e.created_at desc,e.id desc limit (select n+1 from settings)
  ), page as materialized (select * from candidates order by created_at desc,id desc limit (select n from settings)),
  visible as (select e.id,e.title,e.body,e.href,e.created_at,e.read_at from page e
      where rentview_private.inbox_event_visible(e::public.inbox_events))
  select jsonb_build_object('events',coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at desc,v.id desc) from visible v),'[]'::jsonb),
    'next',case when (select count(*) from candidates)>(select n from settings) then
      (select jsonb_build_object('at',created_at,'id',id) from page order by created_at,id limit 1) end);
$$;
create or replace function public.inbox_activity() returns table(id uuid,title text,body text,href text,created_at timestamptz,read_at timestamptz)
language sql stable security definer set search_path='' as $$
  select * from jsonb_to_recordset(public.inbox_activity(null,null,100)->'events')
    as e(id uuid,title text,body text,href text,created_at timestamptz,read_at timestamptz);
$$;
create or replace function public.inbox_unread_count() returns bigint language sql stable security definer set search_path='' as $$
  select count(*) from (select 1 from public.inbox_events e where e.recipient_id=(select auth.uid()) and e.read_at is null
    and rentview_private.inbox_event_visible(e) limit 99) capped;
$$;
create index inbox_recent_unread_repair on public.inbox_events(recipient_id,request_id,created_at desc,id desc)
  where read_at is null and request_id is not null and title='Repair reply';
create or replace function public.unread_repair_replies() returns table(request_id uuid,latest_at timestamptz)
language sql stable security definer set search_path='' as $$
  select repair.request_id,repair.created_at from (
    select distinct on (e.request_id) e.* from public.inbox_events e where e.recipient_id=(select auth.uid())
      and e.read_at is null and e.request_id is not null and e.title='Repair reply'
      order by e.request_id,e.created_at desc,e.id desc) repair
  where rentview_private.inbox_event_visible(repair::public.inbox_events);
$$;
-- Read envelopes expire after 90 days. The thread and repair records have
-- their own retention rules and are never touched by this bounded cleanup.
create index inbox_read_retention on public.inbox_events(read_at,id) where read_at is not null;
create function rentview_private.prune_read_inbox_events() returns integer language plpgsql security definer set search_path='' as $$
declare removed integer;
begin
  with expired as (select id from public.inbox_events where read_at<now()-interval '90 days'
    order by read_at,id limit 5000 for update skip locked)
  delete from public.inbox_events e using expired where e.id=expired.id;
  get diagnostics removed=row_count; return removed;
end $$;
revoke all on function rentview_private.prune_read_inbox_events() from public,anon,authenticated;
revoke all on function public.inbox_activity(timestamptz,uuid,integer),public.inbox_leases(uuid,uuid),
  public.lease_thread(uuid,uuid,uuid) from public,anon;
grant execute on function public.inbox_activity(timestamptz,uuid,integer),public.inbox_leases(uuid,uuid),
  public.lease_thread(uuid,uuid,uuid) to authenticated;

-- Existing deployments with pg_cron start retention on upgrade. The
-- reminder setup script installs the same named job on new deployments.
do $$ begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('rentview-inbox-retention','17 * * * *','select rentview_private.prune_read_inbox_events();');
  end if;
end $$;
notify pgrst,'reload schema';
