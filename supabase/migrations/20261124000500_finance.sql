-- Existing rows keep their meaning. A paid legacy record may stand alone until
-- an owner explicitly associates it with an unpaid charge.
create table public.rent_allocations (
  id uuid primary key,
  charge_id uuid not null references public.rent_payments(id) on delete cascade,
  receipt_id uuid not null references public.rent_payments(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0 and amount <> 'NaN'::numeric),
  created_at timestamptz not null default now(),
  check (charge_id <> receipt_id)
);
create index rent_allocations_charge_idx on public.rent_allocations(charge_id);
create index rent_allocations_receipt_idx on public.rent_allocations(receipt_id);
alter table public.rent_allocations enable row level security;
revoke all on public.rent_allocations from public, anon, authenticated;
grant select on public.rent_allocations to authenticated;
create policy read_linked_rent_allocations on public.rent_allocations for select to authenticated
using ((select public.current_account_is_active()) and exists (
  select 1 from public.rent_payments p where p.id = charge_id
));

create view public.rent_record_balances with (security_invoker = true) as
select p.*, coalesce(a.applied_amount, 0::numeric) as applied_amount
from public.rent_payments p
left join lateral (
  select sum(a.amount) as applied_amount from public.rent_allocations a
  where a.charge_id = p.id or a.receipt_id = p.id
) a on true;
revoke all on public.rent_record_balances from public, anon, authenticated;
grant select on public.rent_record_balances to authenticated;

-- A new receipt and its allocation commit together. An existing receipt may
-- be split across several charges. Both money rows are locked before checking
-- their available amounts. The screen retains its operation id across retries.
create function public.apply_rent_receipt(
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
  perform 1 from public.rent_payments where id in (p_charge_id,p_receipt_id) and owner_id=auth.uid() order by id for update;
  select * into charge from public.rent_payments where id=p_charge_id and owner_id=auth.uid() and paid_on is null;
  if not found or not exists (select 1 from public.leases l where l.id=charge.lease_id and l.owner_id=charge.owner_id) then
    raise exception 'Charge unavailable' using errcode='42501';
  end if;
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
    select receipt.amount-coalesce(sum(a.amount),0) into available from public.rent_allocations a where a.receipt_id=receipt.id;
    if p_amount>available then raise exception 'Amount exceeds the unallocated receipt' using errcode='23514'; end if;
  end if;
  insert into public.rent_allocations(id,charge_id,receipt_id,amount) values(p_operation_id,p_charge_id,p_receipt_id,p_amount);
  return p_operation_id;
end;
$$;
revoke all on function public.apply_rent_receipt(uuid,uuid,uuid,numeric,date,public.payment_method,text,text) from public,anon;
grant execute on function public.apply_rent_receipt(uuid,uuid,uuid,numeric,date,public.payment_method,text,text) to authenticated;

-- Direct record edits from older clients must preserve linked balances too.
create function rentview_private.protect_allocated_rent() returns trigger language plpgsql security definer set search_path='' as $$
declare applied numeric;
begin
  select coalesce(sum(a.amount),0) into applied from public.rent_allocations a where a.charge_id=old.id or a.receipt_id=old.id;
  if applied>0 and (new.amount<applied or new.currency<>old.currency or new.lease_id<>old.lease_id
    or new.owner_id<>old.owner_id or (new.paid_on is null)<>(old.paid_on is null)) then
    raise exception 'This change conflicts with recorded rent allocations' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function rentview_private.protect_allocated_rent() from public,anon,authenticated;
create trigger protect_allocated_rent before update of amount,currency,lease_id,owner_id,paid_on on public.rent_payments
for each row execute function rentview_private.protect_allocated_rent();

-- Reporting projects only the owner's received rent. Payer notes stay on the ledger.
create view public.rent_receipts_report with (security_invoker = true) as
select r.id,r.paid_on,r.amount,r.currency,p.id as property_id,p.name as property_name,u.label as unit_label
from public.rent_payments r
join public.leases l on l.id=r.lease_id and l.owner_id=r.owner_id
join public.units u on u.id=l.unit_id and u.owner_id=l.owner_id
join public.properties p on p.id=u.property_id and p.owner_id=u.owner_id
where r.paid_on is not null and r.owner_id=(select auth.uid());
revoke all on public.rent_receipts_report from public,anon,authenticated;
grant select on public.rent_receipts_report to authenticated;

create index if not exists active_lease_end_reminders_idx on public.leases(end_date,owner_id) where status='active' and end_date is not null;

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
    where r.id is null or (r.status='failed' and r.attempts<8 and r.next_attempt_at<=now())
      or (r.status='processing' and r.attempts<8 and r.locked_at<now()-interval '10 minutes')
    order by o.owner_id limit greatest(1,least(coalesce(p_limit,25),100));
end;
$$;
revoke all on function public.due_reminder_owners(date,date,integer) from public,anon,authenticated;
grant execute on function public.due_reminder_owners(date,date,integer) to service_role;

notify pgrst, 'reload schema';
