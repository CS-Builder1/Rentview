-- Review corrections. Additive to the already-reviewed migrations.
-- Apply only after local replay and the rollout gates in SECURITY_RELEASE_GATES.md.
begin;

-- This performance index belongs to the platform Storage owner. Its explicit
-- owner-only maintenance script is a prerequisite, never privilege escalation
-- hidden in an app migration. Check it before creating/changing any app object.
do $storage_index_prerequisite$
begin
 if not (exists(select 1 from pg_catalog.pg_attribute where attrelid='storage.objects'::regclass and attname='owner_id' and atttypid='text'::regtype and not attisdropped)
 and exists(select 1 from pg_catalog.pg_attribute where attrelid='storage.objects'::regclass and attname='owner' and atttypid='uuid'::regtype and not attisdropped)
 and exists(select 1 from pg_catalog.pg_attribute where attrelid='storage.objects'::regclass and attname='created_at' and atttypid='timestamptz'::regtype and not attisdropped)) or not (exists(
 select 1 from pg_catalog.pg_index i
 join pg_catalog.pg_class c on c.oid=i.indexrelid
 join pg_catalog.pg_class t on t.oid=i.indrelid
 join pg_catalog.pg_am a on a.oid=c.relam
 join pg_catalog.pg_attribute d on d.attrelid=t.oid and d.attname='created_at' and not d.attisdropped
 join pg_catalog.pg_attribute u on u.attrelid=t.oid and u.attname='owner_id' and not u.attisdropped
 where c.oid=pg_catalog.to_regclass('storage.rentview_storage_owner_created_idx')
  and i.indrelid='storage.objects'::regclass and c.relkind='i' and c.relowner=t.relowner
  and a.amname='btree' and i.indisvalid and i.indisready and i.indislive
  and not i.indisunique and not i.indisexclusion and i.indnkeyatts=2 and i.indnatts=2
  and i.indkey[0]=0 and i.indkey[1]=d.attnum and i.indpred is null
  and i.indoption[0]=0 and i.indoption[1]=3
  and i.indcollation[0]=u.attcollation and i.indcollation[1]=0
  and i.indclass[0]=(select oid from pg_catalog.pg_opclass where opcnamespace='pg_catalog'::regnamespace and opcname='text_ops' and opcmethod=c.relam)
  and i.indclass[1]=(select oid from pg_catalog.pg_opclass where opcnamespace='pg_catalog'::regnamespace and opcname='timestamptz_ops' and opcmethod=c.relam)
  and pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.pg_get_expr(i.indexprs,i.indrelid)),'[[:space:]()]','','g')
   =$expression$coalescenullifowner_id,''::text,owner::text$expression$
)) then
  raise exception 'Storage quota index owner maintenance required before review operations migration' using errcode='55000';
 end if;
end $storage_index_prerequisite$;

-- A caller chooses an IANA calendar, never the server clock or a raw offset.
-- The timestamp remains server-assigned; this does not accept backdated costs.
create function rentview_private.calendar_date_at(p_at timestamptz,p_time_zone text)
returns date language plpgsql stable set search_path='' as $$
begin
 if p_at is null or p_time_zone is null or length(p_time_zone)>100
   or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_time_zone) then
  raise exception 'Choose a valid IANA time zone' using errcode='23514';
 end if;
 return (p_at at time zone p_time_zone)::date;
end;
$$;
revoke all on function rentview_private.calendar_date_at(timestamptz,text) from public,anon,authenticated;

-- Replace signatures rather than keeping ambiguous PostgREST overloads.
drop function public.complete_work_order(uuid,numeric,text,text,boolean);
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
  values(w.owner_id,w.property_id,w.unit_id,w.id,w.vendor_id,'repair',coalesce(nullif(trim(p_summary),''),w.title),parts_total+p_labor_amount,p_currency,local_completed_on)
  returning id into expense_id;
 update public.work_orders set status='completed',completed_at=now(),cost=parts_total+p_labor_amount,cost_currency=p_currency,completion_expense_id=expense_id,completion_input=jsonb_build_object('labor',p_labor_amount,'currency',p_currency,'summary',nullif(trim(p_summary),''),'use_existing',p_use_existing_expenses) where id=w.id;
 insert into public.work_order_events(owner_id,work_order_id,asset_id,event_type,summary,data)
  values(w.owner_id,w.id,w.asset_id,'cost_posted',nullif(trim(p_summary),''),jsonb_build_object('expense_id',expense_id,'labor',p_labor_amount,'parts',parts_total,'currency',p_currency));
 return expense_id;
end;
$$;
revoke all on function public.complete_work_order(uuid,numeric,text,text,boolean,text) from public,anon;
grant execute on function public.complete_work_order(uuid,numeric,text,text,boolean,text) to authenticated;

drop function public.complete_maintenance_schedule(uuid,date,text);
create or replace function public.complete_maintenance_schedule(p_schedule_id uuid,p_completed_on date default null,p_notes text default null,p_time_zone text default 'UTC')
returns uuid language plpgsql security definer set search_path = '' as $$
declare s public.maintenance_schedules%rowtype; completion_id uuid; base_date date; due_date date; anchor integer; local_today date;
begin
 if not public.current_account_is_active() then raise exception 'Not authenticated' using errcode='42501'; end if;
 local_today:=rentview_private.calendar_date_at(statement_timestamp(),p_time_zone);
 p_completed_on:=coalesce(p_completed_on,local_today);
 select * into s from public.maintenance_schedules where id=p_schedule_id and owner_id=auth.uid() for update;
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
revoke all on function public.complete_maintenance_schedule(uuid,date,text,text) from public,anon;
grant execute on function public.complete_maintenance_schedule(uuid,date,text,text) to authenticated;

-- Direct schedule edits establish a new fixed-calendar anchor. Internal
-- completion retains the original month-end anchor through shorter months.
create function rentview_private.maintain_schedule_anchor()
returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='INSERT' then
  new.anchor_day:=case when new.cadence='scheduled' then extract(day from new.next_due)::int else null end;
 elsif current_user in ('authenticated','anon','service_role') then
  if new.cadence is distinct from old.cadence or new.next_due is distinct from old.next_due
    or new.frequency is distinct from old.frequency then
   new.anchor_day:=case when new.cadence='scheduled' then extract(day from new.next_due)::int else null end;
  else
   new.anchor_day:=old.anchor_day;
  end if;
 end if;
 return new;
end;
$$;
revoke all on function rentview_private.maintain_schedule_anchor() from public,anon,authenticated;
create trigger maintain_schedule_anchor before insert or update on public.maintenance_schedules
 for each row execute function rentview_private.maintain_schedule_anchor();

create or replace function public.reopen_tenant_request(p_request_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare r public.maintenance_requests%rowtype; linked_status public.wo_status;
begin
 select * into r from public.maintenance_requests where id=p_request_id for update;
 if not found or auth.uid() is null or r.tenant_user_id is distinct from auth.uid() or not public.can_access_request(r.id) then raise exception 'Request not found' using errcode='42501'; end if;
 if length(trim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'Explain what still needs attention' using errcode='23514'; end if;
 if r.status not in ('resolved','closed') then raise exception 'Only resolved or closed requests can be reopened' using errcode='23514'; end if;
 if r.work_order_id is not null then
  -- Completion locks its job before updating the request. Never wait in the
  -- reverse order: fail retryably rather than deadlocking against completion.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('work-order-cost:'||r.work_order_id::text,613)) then
   raise exception 'Repair is being updated. Retry reopening shortly.' using errcode='40001';
  end if;
  begin
   select status into linked_status from public.work_orders where id=r.work_order_id and owner_id=r.owner_id for update nowait;
  exception when lock_not_available then
   raise exception 'Repair is being updated. Retry reopening shortly.' using errcode='40001';
  end;
 end if;
 -- Keep an unfinished job attached. Only terminal history starts new triage.
 update public.maintenance_requests set
  status=case when linked_status is not null and linked_status not in ('completed','cancelled') then 'acknowledged'::public.request_status else 'submitted'::public.request_status end,
  work_order_id=case when linked_status is not null and linked_status not in ('completed','cancelled') then r.work_order_id else null end,
  resolved_at=null,rating=null,rating_comment=null where id=r.id;
 insert into public.request_messages(request_id,sender_id,body) values(r.id,auth.uid(),'Still not fixed: '||trim(p_reason));
end;
$$;
revoke all on function public.reopen_tenant_request(uuid,text) from public,anon;
grant execute on function public.reopen_tenant_request(uuid,text) to authenticated;

-- Cache the row-independent active identity check once per statement. Guard
-- exact policy definitions before touching them; all grants/roles stay intact.
do $optimize_active$
declare item record; expected_count integer;
begin
 select count(*) into expected_count from pg_catalog.pg_policy where polname='current_account_required';
 if expected_count<20 then raise exception 'Expected restrictive account policies are missing'; end if;
 for item in select p.*,n.nspname,c.relname from pg_catalog.pg_policy p
  join pg_catalog.pg_class c on c.oid=p.polrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where p.polname='current_account_required' loop
  if item.nspname not in ('public','storage') or item.polpermissive or item.polcmd<>'*'
    or item.polroles is distinct from array['authenticated'::regrole::oid]
    or (pg_catalog.pg_get_expr(item.polqual,item.polrelid) is distinct from 'current_account_is_active()'
      and pg_catalog.pg_get_expr(item.polqual,item.polrelid) is distinct from 'public.current_account_is_active()')
    or (pg_catalog.pg_get_expr(item.polwithcheck,item.polrelid) is distinct from 'current_account_is_active()'
      and pg_catalog.pg_get_expr(item.polwithcheck,item.polrelid) is distinct from 'public.current_account_is_active()') then
   raise exception 'Reviewed account policy changed: %.%',item.nspname,item.relname;
  end if;
  execute pg_catalog.format('alter policy current_account_required on %I.%I using ((select public.current_account_is_active())) with check ((select public.current_account_is_active()))',item.nspname,item.relname);
 end loop;
end $optimize_active$;

-- The platform-owned Storage index was validated before any mutation above.

-- Capture ownership before object removal so confirmed removed legacy photos
-- (whose uploaded_by is NULL) can be cleared safely. A dropped response after
-- object removal does not lose cleanup provenance. The next call clears
-- proven absent-object metadata without asking Storage to delete that path again.
create table rentview_private.identity_storage_cleanup (
 owner_id uuid not null references auth.users(id) on delete cascade,
 bucket_id text not null,
 name text not null,
 primary key(owner_id,bucket_id,name)
);
alter table rentview_private.identity_storage_cleanup enable row level security;
revoke all on rentview_private.identity_storage_cleanup from public,anon,authenticated;
grant all on rentview_private.identity_storage_cleanup to service_role;

create or replace function public.owned_storage_paths(p_owner_id uuid,p_limit integer default 100)
returns table(bucket_id text,name text) language plpgsql security definer set search_path='' as $$
declare removed_paths text[];
begin
 if not exists(select 1 from public.account_deletion_requests where owner_id=p_owner_id) then
  raise exception 'Deletion has not started' using errcode='23514';
 end if;
 -- A successful remove whose response was lost needs metadata cleanup only.
 -- Never send an absent captured name back to Storage.remove: another request
 -- participant may subsequently re-use that path under their own ownership.
 select array_agg(s.name) into removed_paths from rentview_private.identity_storage_cleanup s
  where s.owner_id=p_owner_id and s.bucket_id='attachments'
   and not exists(select 1 from storage.objects o where o.bucket_id=s.bucket_id and o.name=s.name);
 if removed_paths is not null then perform public.forget_deleted_uploads(p_owner_id,removed_paths); end if;
 -- Re-created foreign objects keep their metadata and are never returned.
 delete from rentview_private.identity_storage_cleanup s where s.owner_id=p_owner_id
  and exists(select 1 from storage.objects o where o.bucket_id=s.bucket_id and o.name=s.name
   and coalesce(nullif(o.owner_id,''),o.owner::text) is distinct from p_owner_id::text);
 return query
 with candidates as materialized (
  select o.bucket_id,o.name from storage.objects o
   where coalesce(nullif(o.owner_id,''),o.owner::text)=p_owner_id::text
  order by 1,2 limit greatest(1,least(coalesce(p_limit,100),1000))
 ), captured as (
  insert into rentview_private.identity_storage_cleanup(owner_id,bucket_id,name)
   select p_owner_id,c.bucket_id,c.name from candidates c where c.bucket_id='attachments'
   on conflict do nothing
 ) select c.bucket_id,c.name from candidates c order by c.bucket_id,c.name;
end;
$$;
revoke all on function public.owned_storage_paths(uuid,integer) from public,anon,authenticated;
grant execute on function public.owned_storage_paths(uuid,integer) to service_role;

create or replace function public.forget_deleted_uploads(p_owner_id uuid,p_paths text[])
returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.account_deletion_requests where owner_id=p_owner_id) then raise exception 'Deletion has not started' using errcode='23514'; end if;
 -- The service calls only after Storage remove succeeds. Additionally require
 -- the captured owner/bucket/path and absence of the corresponding object.
 -- Arbitrary or foreign p_paths cannot delete another participant's metadata.
 with confirmed as (
  select s.name from rentview_private.identity_storage_cleanup s
   where s.owner_id=p_owner_id and s.bucket_id='attachments' and s.name=any(p_paths)
    and not exists(select 1 from storage.objects o where o.bucket_id=s.bucket_id and o.name=s.name)
 ) delete from public.request_photos p where p.storage_path in (select name from confirmed);
 with confirmed as (
  select s.name from rentview_private.identity_storage_cleanup s
   where s.owner_id=p_owner_id and s.bucket_id='attachments' and s.name=any(p_paths)
    and not exists(select 1 from storage.objects o where o.bucket_id=s.bucket_id and o.name=s.name)
 ) delete from public.documents d where d.owner_id=p_owner_id and d.storage_path in (select name from confirmed);
 delete from rentview_private.identity_storage_cleanup s
  where s.owner_id=p_owner_id and s.bucket_id='attachments' and s.name=any(p_paths)
   and not exists(select 1 from storage.objects o where o.bucket_id=s.bucket_id and o.name=s.name);
end;
$$;
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
    if (select count(*) from storage.objects o where coalesce(nullif(o.owner_id,''),o.owner::text)=auth.uid()::text and o.created_at>now()-interval '1 minute')>=100 then
      raise exception 'Too many uploads. Please wait a minute and try again.' using errcode='54000';
    end if;
  end if;
  return new;
end; $$;
revoke all on function rentview_private.reject_deleting_account_writes() from public,anon,authenticated;

notify pgrst, 'reload schema';
commit;
