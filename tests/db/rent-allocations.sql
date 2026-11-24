-- Disposable authenticated-owner and tenant fixtures. Every change rolls back.
begin;
set local statement_timeout='20s';
create function pg_temp.check_rent(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Rent assertion failed: %',message; end if; end $$;
create function pg_temp.refused(sql text,expected text) returns void language plpgsql as $$
begin
  begin execute sql;
  exception when others then if sqlstate=expected then return; end if; raise;
  end;
  raise exception 'Expected %',expected;
end $$;
create function pg_temp.rent_actor(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',uid,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated')::text,true);
end $$;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
('d9100000-0000-4000-8000-000000000001','rent-owner@example.test',now(),'{}'),
('d9100000-0000-4000-8000-000000000002','rent-tenant@example.test',now(),'{}'),
('d9100000-0000-4000-8000-000000000003','rent-other@example.test',now(),'{}');
insert into public.properties(id,owner_id,name) values
('d9200000-0000-4000-8000-000000000001','d9100000-0000-4000-8000-000000000001','Rent fixture');
insert into public.units(id,owner_id,property_id,label) values
('d9300000-0000-4000-8000-000000000001','d9100000-0000-4000-8000-000000000001','d9200000-0000-4000-8000-000000000001','Unit A');
insert into public.leases(id,owner_id,unit_id,tenant_name,tenant_user_id,status,end_date) values
('d9400000-0000-4000-8000-000000000001','d9100000-0000-4000-8000-000000000001','d9300000-0000-4000-8000-000000000001','Tenant A','d9100000-0000-4000-8000-000000000002','active',current_date+8);
insert into public.rent_payments(id,owner_id,lease_id,currency,amount,paid_on) values
('d9500000-0000-4000-8000-000000000001','d9100000-0000-4000-8000-000000000001','d9400000-0000-4000-8000-000000000001','USD',1000,null),
('d9500000-0000-4000-8000-000000000002','d9100000-0000-4000-8000-000000000001','d9400000-0000-4000-8000-000000000001','USD',100,null),
('d9500000-0000-4000-8000-000000000003','d9100000-0000-4000-8000-000000000001','d9400000-0000-4000-8000-000000000001','USD',450,current_date-3),
('d9500000-0000-4000-8000-000000000004','d9100000-0000-4000-8000-000000000001','d9400000-0000-4000-8000-000000000001','EUR',200,current_date-3);
select pg_temp.check_rent(exists(select 1 from public.due_reminder_owners(current_date,current_date+30,100) where owner_id='d9100000-0000-4000-8000-000000000001'),'owner with only a lease expiry is eligible');
select pg_temp.rent_actor('d9100000-0000-4000-8000-000000000001');
set local role authenticated;
select public.apply_rent_receipt('d9600000-0000-4000-8000-000000000001','d9500000-0000-4000-8000-000000000001','d9500000-0000-4000-8000-000000000003',400);
select public.apply_rent_receipt('d9600000-0000-4000-8000-000000000001','d9500000-0000-4000-8000-000000000001','d9500000-0000-4000-8000-000000000003',400);
select public.apply_rent_receipt('d9600000-0000-4000-8000-000000000002','d9500000-0000-4000-8000-000000000002','d9500000-0000-4000-8000-000000000003',50);
select pg_temp.check_rent((select amount-applied_amount=600 from public.rent_record_balances where id='d9500000-0000-4000-8000-000000000001'),'partial charge after retry');
select pg_temp.check_rent((select applied_amount=450 from public.rent_record_balances where id='d9500000-0000-4000-8000-000000000003'),'one receipt split across charges');
select pg_temp.refused($q$select public.apply_rent_receipt(gen_random_uuid(),'d9500000-0000-4000-8000-000000000001','d9500000-0000-4000-8000-000000000003',1)$q$,'23514');
select pg_temp.refused($q$select public.apply_rent_receipt(gen_random_uuid(),'d9500000-0000-4000-8000-000000000001','d9500000-0000-4000-8000-000000000004',1)$q$,'23514');
select pg_temp.refused($q$update public.rent_payments set amount=1 where id='d9500000-0000-4000-8000-000000000001'$q$,'23514');
select public.apply_rent_receipt('d9600000-0000-4000-8000-000000000003','d9500000-0000-4000-8000-000000000001','d9500000-0000-4000-8000-000000000005',600,current_date-1,'cash','Paid remainder');
select pg_temp.check_rent((select amount=applied_amount from public.rent_record_balances where id='d9500000-0000-4000-8000-000000000001'),'charge settled');
select pg_temp.check_rent((select sum(amount)=1050 from public.rent_receipts_report where currency='USD'),'receipt counted once despite split allocation');
select pg_temp.rent_actor('d9100000-0000-4000-8000-000000000002');
select pg_temp.check_rent((select amount=applied_amount from public.rent_record_balances where id='d9500000-0000-4000-8000-000000000001'),'tenant sees reconciled charge');
select pg_temp.refused($q$select public.apply_rent_receipt(gen_random_uuid(),'d9500000-0000-4000-8000-000000000002',gen_random_uuid(),1,current_date-1)$q$,'42501');
select pg_temp.rent_actor('d9100000-0000-4000-8000-000000000003');
select pg_temp.check_rent(not exists(select 1 from public.rent_record_balances where lease_id='d9400000-0000-4000-8000-000000000001'),'unrelated account sees no records');
select pg_temp.rent_actor('d9100000-0000-4000-8000-000000000001');
delete from public.rent_payments where id='d9500000-0000-4000-8000-000000000005';
select pg_temp.check_rent((select amount-applied_amount=600 from public.rent_record_balances where id='d9500000-0000-4000-8000-000000000001'),'receipt reversal restores charge');
rollback;
