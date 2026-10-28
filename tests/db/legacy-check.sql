-- Disposable local database only, AFTER legacy-seed.sql and the pending SQL.
-- A successful run commits cleanup of the three exact synthetic identities.
begin;
create function pg_temp.assert_true(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Assertion failed: %',message; end if; end $$;
create function pg_temp.expect_error(statement text,expected_state text) returns void language plpgsql as $$
begin
 begin execute statement;
 exception when others then
  if sqlstate=expected_state then return; end if;
  raise exception 'Expected SQLSTATE %, got %: %',expected_state,sqlstate,sqlerrm;
 end;
 raise exception 'Expected SQLSTATE %, but statement succeeded',expected_state;
end $$;
create function pg_temp.actor(uid text) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',uid,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated')::text,true);
end $$;
select pg_temp.assert_true((select count(*)=1 from public.units where id='92000000-0000-4000-8000-000000000001'),'migration preserves inconsistent legacy unit for reconciliation');
select pg_temp.assert_true((select count(*)=1 from public.maintenance_requests where id='94000000-0000-4000-8000-000000000001'),'migration preserves legacy request');
select pg_temp.assert_true((select billing_verified_at is null from public.subscriptions where owner_id='90000000-0000-4000-8000-000000000001'),'client-writable legacy subscription stays unverified');
select pg_temp.assert_true((select count(*)=0 from public.billing_subscription_states where owner_id='90000000-0000-4000-8000-000000000001'),'legacy entitlement never becomes a trusted provider binding');
select pg_temp.expect_error($q$alter table public.units validate constraint units_property_id_owner_fk$q$,'23503');
set local role authenticated;
select pg_temp.actor('90000000-0000-4000-8000-000000000001');
select pg_temp.assert_true((select count(*)=0 from public.maintenance_requests where id='94000000-0000-4000-8000-000000000001'),'legacy nominal owner cannot traverse a foreign request location');
select pg_temp.assert_true((select count(*)=0 from public.request_messages where request_id='94000000-0000-4000-8000-000000000001'),'legacy inconsistent thread is hidden');
insert into public.properties(owner_id,name) values(auth.uid(),'Synthetic legacy cap second'),(auth.uid(),'Synthetic legacy cap third');
select pg_temp.expect_error($q$insert into public.properties(owner_id,name) values(auth.uid(),'Synthetic legacy cap fourth')$q$,'23514');
select pg_temp.actor('90000000-0000-4000-8000-000000000003');
select pg_temp.assert_true((select count(*)=1 from public.tenant_lease_details where lease_id='93000000-0000-4000-8000-000000000001'),'valid lease still visible beside invalid legacy request');
select pg_temp.assert_true((select count(*)=0 from public.maintenance_requests where id='94000000-0000-4000-8000-000000000001'),'legacy tenant cannot traverse inconsistent request');
select pg_temp.expect_error($q$select public.claim_tenant_invite('LEGACYSYNTHETICINVALIDINVITATION')$q$,'23514');
reset role;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
-- Remove the inconsistent nominal owner first so its rows are deleted instead
-- of being updated by a tenant-identity FK while still awaiting reconciliation.
delete from auth.users where id='90000000-0000-4000-8000-000000000001';
delete from auth.users where id in ('90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000003');
-- Flush deferred completion-history FK events from the fixture cascade before
-- ALTER TABLE. PostgreSQL forbids validation while such events are pending.
set constraints all immediate;
do $$ declare c record; begin
 for c in select n.nspname,t.relname,con.conname from pg_constraint con
   join pg_class t on t.oid=con.conrelid join pg_namespace n on n.oid=t.relnamespace
   where n.nspname='public' and not con.convalidated
 loop execute format('alter table %I.%I validate constraint %I',c.nspname,c.relname,c.conname); end loop;
end $$;
select pg_temp.assert_true(not exists(select 1 from pg_constraint con join pg_class t on t.oid=con.conrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname='public' and not con.convalidated),'clean local fixtures validate every pending public constraint');
commit;
