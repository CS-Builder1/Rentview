-- Disposable local database only. The public invoker view must expose the
-- approved tenant projection while leaving owner-private base rows hidden.
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
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('c1000000-0000-4000-8000-000000000001','projection-owner-a@example.test',now(),'{"full_name":"Approved landlord A"}'),
 ('c1000000-0000-4000-8000-000000000002','projection-owner-b@example.test',now(),'{"full_name":"Approved landlord B"}'),
 ('c1000000-0000-4000-8000-000000000003','projection-tenant-a@example.test',now(),'{}'),
 ('c1000000-0000-4000-8000-000000000004','projection-tenant-b@example.test',now(),'{}');
insert into public.properties(id,owner_id,name,notes) values
 ('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','Approved building A','Private owner note A'),
 ('c2000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000002','Approved building B','Private owner note B');
insert into public.units(id,owner_id,property_id,label,notes) values
 ('c3000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','Approved unit A','Private unit note A'),
 ('c3000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000002','c2000000-0000-4000-8000-000000000002','Approved unit B','Private unit note B');
insert into public.leases(id,owner_id,unit_id,tenant_user_id,tenant_name,tenant_email,tenant_phone,notes,rent_amount,rent_currency,deposit_amount) values
 ('c4000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000003','Private tenant A','projection-tenant-a@example.test','+10000000001','Private lease note A',100,'USD',100),
 ('c4000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000002','c3000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000004','Private tenant B','projection-tenant-b@example.test','+10000000002','Private lease note B',200,'EUR',200);
select pg_temp.assert_true((select 'security_invoker=true'=any(reloptions) from pg_class where oid='public.tenant_lease_details'::regclass),'public projection runs with caller privileges');
select pg_temp.assert_true(not has_function_privilege('anon','rentview_private.current_tenant_lease_details()','execute'),'anonymous helper execution denied');
select pg_temp.assert_true(has_function_privilege('authenticated','rentview_private.current_tenant_lease_details()','execute'),'authenticated tenant may invoke scoped helper');
select pg_temp.assert_true(to_regprocedure('rentview_private.current_tenant_lease_details(uuid)') is null,'projection accepts no caller-chosen identity');
select pg_temp.assert_true(not has_schema_privilege('anon','rentview_private','usage'),'anonymous schema access remains denied');
do $$ declare helper record; begin
 for helper in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='rentview_private' loop
  assert not has_function_privilege('anon',helper.oid,'execute'),'anonymous can execute a private helper';
  if helper.oid<>'rentview_private.current_tenant_lease_details()'::regprocedure then
   assert not has_function_privilege('authenticated',helper.oid,'execute'),'schema usage exposed another private helper';
  end if;
 end loop;
end $$;
set local role anon;
select pg_temp.expect_error('select * from public.tenant_lease_details','42501');
select pg_temp.expect_error('select * from rentview_private.current_tenant_lease_details()','42501');
reset role;
set local role authenticated;
select pg_temp.actor('c1000000-0000-4000-8000-000000000003');
select pg_temp.assert_true((select count(*)=1 from public.tenant_lease_details),'tenant A gets one own lease');
select pg_temp.assert_true((select lease_id='c4000000-0000-4000-8000-000000000001' and landlord_name='Approved landlord A' and rent_amount=100 from public.tenant_lease_details),'approved display data survives projection');
select pg_temp.assert_true((select count(*)=0 from public.tenant_lease_details where owner_id='c1000000-0000-4000-8000-000000000002'),'tenant A cannot query a foreign owner');
select pg_temp.assert_true((select count(*)=1 from rentview_private.current_tenant_lease_details()),'direct private helper has the same actor boundary');
select pg_temp.assert_true((select count(*)=0 from public.leases),'projection does not widen base lease reads');
select pg_temp.assert_true((select count(*)=0 from public.units),'projection does not widen base unit reads');
select pg_temp.assert_true((select count(*)=0 from public.properties),'projection does not widen base property reads');
select pg_temp.assert_true((select count(*)=0 from public.profiles where id<>auth.uid()),'projection does not widen landlord profile reads');
select pg_temp.assert_true((select array_agg(k order by k)=array(select x from unnest(array['lease_id','unit_id','owner_id','start_date','end_date','rent_amount','rent_currency','deposit_amount','status','unit_label','unit_type','property_id','property_name','address_line1','city','region','country','landlord_name']) x order by x)
 from public.tenant_lease_details d cross join lateral jsonb_object_keys(to_jsonb(d)) keys(k)),'projection redacts all unapproved lease/property/profile fields');
select pg_temp.actor('c1000000-0000-4000-8000-000000000004');
select pg_temp.assert_true((select count(*)=1 and bool_and(lease_id='c4000000-0000-4000-8000-000000000002') from public.tenant_lease_details),'tenant B sees only its own membership');
select pg_temp.actor('c1000000-0000-4000-8000-000000000001');
select pg_temp.assert_true((select count(*)=0 from public.tenant_lease_details),'ownership alone cannot select a tenant projection');
update public.leases set tenant_user_id=null where id='c4000000-0000-4000-8000-000000000001';
select pg_temp.actor('c1000000-0000-4000-8000-000000000003');
select pg_temp.assert_true((select count(*)=0 from public.tenant_lease_details),'membership revocation removes view reads');
select pg_temp.assert_true((select count(*)=0 from rentview_private.current_tenant_lease_details()),'membership revocation removes helper reads');
reset role;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
update public.leases set tenant_user_id='c1000000-0000-4000-8000-000000000003' where id='c4000000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.actor('c1000000-0000-4000-8000-000000000003');
select pg_temp.assert_true((select count(*)=1 from public.tenant_lease_details),'restored fixture membership is visible before deletion');
reset role;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
select public.prepare_identity_deletion('c1000000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.actor('c1000000-0000-4000-8000-000000000003');
select pg_temp.assert_true((select count(*)=0 from public.tenant_lease_details),'deleting account cannot read projection');
select pg_temp.assert_true((select count(*)=0 from rentview_private.current_tenant_lease_details()),'deleting account cannot bypass through helper');
select pg_temp.actor('c1000000-0000-4000-8000-000000000005');
select pg_temp.assert_true((select count(*)=0 from public.tenant_lease_details),'nonexistent actor gets no projection');
rollback;
