-- Preserve grants on the deployed functions and security-invoker views.
create or replace function public.apply_rent_receipt(
  p_operation_id uuid, p_charge_id uuid, p_receipt_id uuid, p_amount numeric,
  p_paid_on date default null, p_method public.payment_method default null, p_note text default null,
  p_time_zone text default 'UTC'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  charge public.rent_payments%rowtype;
  receipt public.rent_payments%rowtype;
  prior public.rent_allocations%rowtype;
  due numeric;
  available numeric;
begin
  if not public.current_account_is_active() then
    raise exception 'Sign in to record rent' using errcode='42501';
  end if;
  if p_operation_id is null or p_charge_id is null or p_receipt_id is null or p_charge_id=p_receipt_id
    or p_amount is null or p_amount not between 0.01 and 9999999999.99 or p_amount <> round(p_amount,2) then
    raise exception 'Choose a charge and a positive amount in cents' using errcode='23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('rent-allocation:' || p_operation_id::text, 0));
  -- Establish scope before locking anything. Lock in a stable order and reread
  -- after waiting so concurrent changes or transfers cannot cross portfolios.
  select p.* into charge from public.rent_payments p
  join public.leases l on l.id=p.lease_id and l.owner_id=p.owner_id
  where p.id=p_charge_id and p.paid_on is null and public.can_manage_lease(l.id);
  if not found then raise exception 'Charge unavailable' using errcode='42501'; end if;
  perform 1 from public.rent_payments p where p.id in (p_charge_id,p_receipt_id)
    and p.owner_id=charge.owner_id and p.lease_id=charge.lease_id order by p.id for update;
  select p.* into charge from public.rent_payments p
  join public.leases l on l.id=p.lease_id and l.owner_id=p.owner_id
  where p.id=p_charge_id and p.owner_id=charge.owner_id and p.lease_id=charge.lease_id
    and p.paid_on is null and public.can_manage_lease(l.id);
  if not found then raise exception 'Charge unavailable' using errcode='42501'; end if;
  select * into receipt from public.rent_payments where id=p_receipt_id and owner_id=charge.owner_id;
  select * into prior from public.rent_allocations where id=p_operation_id;
  if found then
    if prior.charge_id=p_charge_id and prior.receipt_id=p_receipt_id and prior.amount=p_amount
      and (p_paid_on is null or (receipt.paid_on=p_paid_on and receipt.method is not distinct from p_method
        and receipt.note is not distinct from nullif(trim(p_note),''))) then
      return prior.id;
    end if;
    raise exception 'This receipt operation already has different details' using errcode='23505';
  end if;
  select charge.amount-coalesce(sum(a.amount),0) into due from public.rent_allocations a where a.charge_id=charge.id;
  if p_amount>due then raise exception 'Amount exceeds the remaining charge' using errcode='23514'; end if;
  if p_paid_on is not null then
    if receipt.id is not null then raise exception 'Receipt already exists. Choose it from recorded receipts.' using errcode='23505'; end if;
    if p_paid_on>rentview_private.calendar_date_at(statement_timestamp(),p_time_zone) then
      raise exception 'Receipt date cannot be in the future' using errcode='23514';
    end if;
    insert into public.rent_payments(id,owner_id,lease_id,currency,amount,paid_on,method,note)
    values(p_receipt_id,charge.owner_id,charge.lease_id,charge.currency,p_amount,p_paid_on,p_method,nullif(trim(p_note),''));
  else
    if receipt.id is null or receipt.paid_on is null or receipt.lease_id<>charge.lease_id or receipt.currency<>charge.currency then
      raise exception 'Choose a receipt from the same lease and currency' using errcode='23514';
    end if;
    if receipt.due_date is not null then
      raise exception 'This receipt already settled its own charge' using errcode='23514';
    end if;
    select receipt.amount-coalesce(sum(a.amount),0) into available from public.rent_allocations a where a.receipt_id=receipt.id;
    if p_amount>available then raise exception 'Amount exceeds the unallocated receipt' using errcode='23514'; end if;
  end if;
  insert into public.rent_allocations(id,charge_id,receipt_id,amount) values(p_operation_id,p_charge_id,p_receipt_id,p_amount);
  return p_operation_id;
end;
$$;

create or replace function rentview_private.protect_allocated_rent() returns trigger language plpgsql security definer set search_path='' as $$
declare applied numeric;
begin
  select coalesce(sum(a.amount),0) into applied from public.rent_allocations a where a.charge_id=old.id or a.receipt_id=old.id;
  if applied>0 and (new.amount<applied or new.currency<>old.currency or new.lease_id<>old.lease_id
    or (new.owner_id<>old.owner_id and not exists(
      select 1 from rentview_private.owner_change where txid=txid_current() and original=old.owner_id and successor=new.owner_id))
    or (old.paid_on is not null and old.due_date is null and new.due_date is not null)
    or (new.paid_on is null)<>(old.paid_on is null)) then
    raise exception 'This change conflicts with recorded rent allocations' using errcode='23514';
  end if;
  return new;
end;
$$;

drop trigger protect_allocated_rent on public.rent_payments;
create trigger protect_allocated_rent before update of amount,currency,lease_id,owner_id,paid_on,due_date on public.rent_payments
for each row execute function rentview_private.protect_allocated_rent();

create or replace view public.rent_record_balances with (security_invoker = true) as
select p.*, case when p.paid_on is not null and p.due_date is not null then p.amount
  else coalesce(a.applied_amount, 0::numeric) end as applied_amount
from public.rent_payments p
left join lateral (
  select sum(a.amount) as applied_amount from public.rent_allocations a
  where a.charge_id = p.id or a.receipt_id = p.id
) a on true;

create or replace view public.rent_receipts_report with (security_invoker = true) as
select r.id,r.paid_on,r.amount,r.currency,p.id as property_id,p.name as property_name,u.label as unit_label
from public.rent_payments r
join public.leases l on l.id=r.lease_id and l.owner_id=r.owner_id
join public.units u on u.id=l.unit_id and u.owner_id=l.owner_id
join public.properties p on p.id=u.property_id and p.owner_id=u.owner_id
where r.paid_on is not null and public.can_manage_lease(l.id);

create or replace function public.due_reminder_owners(p_today date,p_soon date,p_limit integer default 25)
returns table(owner_id uuid) language plpgsql security definer set search_path='' as $$
begin
  update public.reminder_deliveries r set status='failed',locked_at=null,claim_token=null,
    last_error=coalesce(r.last_error,'Reminder worker did not finish before the retry limit')
    where r.attempts>=8 and r.status='processing' and r.locked_at<now()-interval '10 minutes';
  return query with owners as (
    select a.owner_id from public.assets a where a.warranty_expiry between p_today and p_soon
    union select m.owner_id from public.maintenance_schedules m where m.is_active and m.next_due<=p_today
    union select l.owner_id from public.leases l where l.status='active' and l.end_date between p_today and p_soon
  ) select o.owner_id from owners o left join public.reminder_deliveries r on r.owner_id=o.owner_id and r.reminder_day=p_today
    where not exists(select 1 from public.account_deletion_requests d where d.owner_id=o.owner_id)
      and (r.id is null or (r.status='failed' and r.attempts<8 and r.next_attempt_at<=now())
      or (r.status='processing' and r.attempts<8 and r.locked_at<now()-interval '10 minutes'))
    order by o.owner_id limit greatest(1,least(coalesce(p_limit,25),100));
end;
$$;

-- 00400 used this literal to identify the original schedule snapshot. Keep
-- explicit provenance when confirming the service or retrying that command.
alter table public.maintenance_completions add column imported_from_schedule boolean not null default false;
update public.maintenance_completions set imported_from_schedule=true
where notes='Latest completion recorded on the original schedule';

create or replace function public.complete_maintenance_schedule(p_schedule_id uuid,p_completed_on date default null,p_notes text default null,p_time_zone text default 'UTC')
returns uuid language plpgsql security definer set search_path = '' as $$
declare s public.maintenance_schedules%rowtype; existing public.maintenance_completions%rowtype; completion_id uuid; base_date date; due_date date; anchor integer; local_today date;
begin
 if not public.current_account_is_active() then raise exception 'Not authenticated' using errcode='42501'; end if;
 local_today:=rentview_private.calendar_date_at(statement_timestamp(),p_time_zone);
 p_completed_on:=coalesce(p_completed_on,local_today);
 select * into s from public.maintenance_schedules where id=p_schedule_id and (owner_id=auth.uid() or public.manages_owned_property(property_id,owner_id)) for update;
 if not found then raise exception 'Schedule not found' using errcode='42501'; end if;
 select * into existing from public.maintenance_completions where schedule_id=s.id and completed_on=p_completed_on;
 if found and not existing.imported_from_schedule then
   if existing.notes is distinct from nullif(trim(p_notes),'') then
     raise exception 'A completion with different notes already exists for this date' using errcode='23514';
   end if;
   return existing.id;
 end if;
 if not s.is_active then raise exception 'Resume this schedule before completing it' using errcode='23514'; end if;
 if p_completed_on is null or p_completed_on>local_today or (s.last_done is not null and p_completed_on<s.last_done) then raise exception 'Choose a valid completion date, not before the previous completion' using errcode='23514'; end if;
 if length(coalesce(p_notes,''))>10000 then raise exception 'Completion note is too long' using errcode='23514'; end if;
 base_date:=case when s.cadence='scheduled' then coalesce(s.next_due,p_completed_on) else p_completed_on end;
 anchor:=case when s.cadence='scheduled' then coalesce(s.anchor_day,extract(day from base_date)::int) else extract(day from p_completed_on)::int end;
 -- Imported snapshots preserve the schedule as it stood. A future due date
 -- already reflects this service and must not advance twice on confirmation.
 due_date:=case when existing.imported_from_schedule and s.next_due>p_completed_on then s.next_due
   else rentview_private.next_maintenance_date(base_date,p_completed_on,s.frequency,s.interval_days,anchor) end;
 if existing.id is not null then
   update public.maintenance_completions set notes=nullif(trim(p_notes),''),next_due=due_date,imported_from_schedule=false
   where id=existing.id returning id into completion_id;
 else
   insert into public.maintenance_completions(owner_id,schedule_id,property_id,unit_id,asset_id,completed_on,notes,next_due)
   values(s.owner_id,s.id,s.property_id,s.unit_id,s.asset_id,p_completed_on,nullif(trim(p_notes),''),due_date) returning id into completion_id;
 end if;
 update public.maintenance_schedules set last_done=p_completed_on,next_due=due_date,anchor_day=case when s.cadence='scheduled' then anchor else null end where id=s.id;
 return completion_id;
end;
$$;

notify pgrst, 'reload schema';
