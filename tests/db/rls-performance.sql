-- Disposable local database only, after the identity InitPlan migration.
-- Every fixture and data mutation is rolled back. Uses real RLS and prepared
-- statements; deliberately forces a reusable generic plan across actor changes.
begin;
set local plan_cache_mode=force_generic_plan;
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
 perform set_config('request.jwt.claim.sub',coalesce(uid,''),true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated')::text,true);
end $$;
create function pg_temp.expect_prepared(expected uuid[],message text) returns void language plpgsql as $$
declare actual uuid[];
begin
 execute 'execute rentview_rls_perf_owner_read' into actual;
 perform pg_temp.assert_true(actual is not distinct from expected,message);
end $$;
create function pg_temp.plan_nodes(node jsonb) returns setof jsonb language sql as $$
 with recursive nodes(node) as (
  select $1 union all
  select child from nodes cross join lateral jsonb_array_elements(coalesce(nodes.node->'Plans','[]'::jsonb)) child
 ) select node from nodes;
$$;

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('d6100000-0000-4000-8000-000000000001','rls-owner-a@example.test',now(),'{}'),
 ('d6100000-0000-4000-8000-000000000002','rls-owner-b@example.test',now(),'{}'),
 ('d6100000-0000-4000-8000-000000000003','rls-tenant@example.test',now(),'{}'),
 ('d6100000-0000-4000-8000-000000000004','rls-deleting@example.test',now(),'{}'),
 ('d6100000-0000-4000-8000-000000000005','rls-deleted@example.test',now(),'{}');
insert into public.properties(id,owner_id,name) values
 ('d6200000-0000-4000-8000-000000000001','d6100000-0000-4000-8000-000000000001','RLS building A'),
 ('d6200000-0000-4000-8000-000000000002','d6100000-0000-4000-8000-000000000002','RLS building B'),
 ('d6200000-0000-4000-8000-000000000004','d6100000-0000-4000-8000-000000000004','RLS deleting building'),
 ('d6200000-0000-4000-8000-000000000005','d6100000-0000-4000-8000-000000000005','RLS deleted building');
insert into public.units(id,owner_id,property_id,label) values
 ('d6300000-0000-4000-8000-000000000001','d6100000-0000-4000-8000-000000000001','d6200000-0000-4000-8000-000000000001','RLS unit A'),
 ('d6300000-0000-4000-8000-000000000002','d6100000-0000-4000-8000-000000000002','d6200000-0000-4000-8000-000000000002','RLS unit B');
insert into public.leases(id,owner_id,unit_id,tenant_user_id,tenant_name,status) values
 ('d6400000-0000-4000-8000-000000000001','d6100000-0000-4000-8000-000000000001','d6300000-0000-4000-8000-000000000001','d6100000-0000-4000-8000-000000000003','RLS tenant','active'),
 ('d6400000-0000-4000-8000-000000000002','d6100000-0000-4000-8000-000000000002','d6300000-0000-4000-8000-000000000002',null,'Other RLS tenant','active');
insert into public.rent_payments(id,owner_id,lease_id,amount,currency) values
 ('d6500000-0000-4000-8000-000000000001','d6100000-0000-4000-8000-000000000001','d6400000-0000-4000-8000-000000000001',100,'USD'),
 ('d6500000-0000-4000-8000-000000000002','d6100000-0000-4000-8000-000000000002','d6400000-0000-4000-8000-000000000002',200,'USD');
insert into public.announcements(id,owner_id,property_id,title) values
 ('d6600000-0000-4000-8000-000000000001','d6100000-0000-4000-8000-000000000001','d6200000-0000-4000-8000-000000000001','RLS property notice A'),
 ('d6600000-0000-4000-8000-000000000002','d6100000-0000-4000-8000-000000000002','d6200000-0000-4000-8000-000000000002','RLS property notice B'),
 ('d6600000-0000-4000-8000-000000000003','d6100000-0000-4000-8000-000000000001',null,'RLS portfolio notice A');
insert into public.notification_prefs(user_id) values
 ('d6100000-0000-4000-8000-000000000001'),('d6100000-0000-4000-8000-000000000002'),('d6100000-0000-4000-8000-000000000004');
insert into public.push_tokens(id,user_id,token,platform) values
 ('d6700000-0000-4000-8000-000000000001','d6100000-0000-4000-8000-000000000001','ExponentPushToken[rls-perf-a-123456789]','web'),
 ('d6700000-0000-4000-8000-000000000002','d6100000-0000-4000-8000-000000000002','ExponentPushToken[rls-perf-b-123456789]','web');


-- Exact reviewed predicate manifest. Exercise both sides of every USING and
-- WITH CHECK predicate for own, foreign and NULL row identities under six
-- request identities, preserving SQL NULL semantics rather than treating NULL
-- as false prematurely. Actual metadata preservation is checked separately by
-- compare-rls-snapshot.py against the pre-migration snapshot.
create temporary table rls_perf_expected(table_name text,policy_name text,column_name text,command text) on commit drop;
insert into rls_perf_expected values
 ('properties','owner_select_properties','owner_id','r'),
 ('properties','owner_insert_properties','owner_id','a'),
 ('properties','owner_update_properties','owner_id','w'),
 ('properties','owner_delete_properties','owner_id','d'),
 ('units','owner_select_units','owner_id','r'),
 ('units','owner_insert_units','owner_id','a'),
 ('units','owner_update_units','owner_id','w'),
 ('units','owner_delete_units','owner_id','d'),
 ('leases','owner_select_leases','owner_id','r'),
 ('leases','owner_insert_leases','owner_id','a'),
 ('leases','owner_update_leases','owner_id','w'),
 ('leases','owner_delete_leases','owner_id','d'),
 ('vendors','owner_select_vendors','owner_id','r'),
 ('vendors','owner_insert_vendors','owner_id','a'),
 ('vendors','owner_update_vendors','owner_id','w'),
 ('vendors','owner_delete_vendors','owner_id','d'),
 ('assets','owner_select_assets','owner_id','r'),
 ('assets','owner_insert_assets','owner_id','a'),
 ('assets','owner_update_assets','owner_id','w'),
 ('assets','owner_delete_assets','owner_id','d'),
 ('work_orders','owner_select_work_orders','owner_id','r'),
 ('work_orders','owner_insert_work_orders','owner_id','a'),
 ('work_orders','owner_update_work_orders','owner_id','w'),
 ('work_orders','owner_delete_work_orders','owner_id','d'),
 ('inventory_items','owner_select_inventory_items','owner_id','r'),
 ('inventory_items','owner_insert_inventory_items','owner_id','a'),
 ('inventory_items','owner_update_inventory_items','owner_id','w'),
 ('inventory_items','owner_delete_inventory_items','owner_id','d'),
 ('work_order_parts','owner_select_work_order_parts','owner_id','r'),
 ('work_order_parts','owner_insert_work_order_parts','owner_id','a'),
 ('work_order_parts','owner_update_work_order_parts','owner_id','w'),
 ('work_order_parts','owner_delete_work_order_parts','owner_id','d'),
 ('expenses','owner_select_expenses','owner_id','r'),
 ('expenses','owner_insert_expenses','owner_id','a'),
 ('expenses','owner_update_expenses','owner_id','w'),
 ('expenses','owner_delete_expenses','owner_id','d'),
 ('tasks','owner_select_tasks','owner_id','r'),
 ('tasks','owner_insert_tasks','owner_id','a'),
 ('tasks','owner_update_tasks','owner_id','w'),
 ('tasks','owner_delete_tasks','owner_id','d'),
 ('maintenance_schedules','owner_select_maintenance_schedules','owner_id','r'),
 ('maintenance_schedules','owner_insert_maintenance_schedules','owner_id','a'),
 ('maintenance_schedules','owner_update_maintenance_schedules','owner_id','w'),
 ('maintenance_schedules','owner_delete_maintenance_schedules','owner_id','d'),
 ('documents','owner_select_documents','owner_id','r'),
 ('documents','owner_insert_documents','owner_id','a'),
 ('documents','owner_update_documents','owner_id','w'),
 ('documents','owner_delete_documents','owner_id','d'),
 ('subscriptions','owner_select_subscriptions','owner_id','r'),
 ('profiles','profiles_select_self','id','r'),
 ('profiles','profiles_update_self','id','w'),
 ('profiles','profiles_insert_self','id','a'),
 ('tenant_invites','owner_select_tenant_invites','owner_id','r'),
 ('tenant_invites','owner_delete_tenant_invites','owner_id','d'),
 ('rent_payments','owner_select_rent_payments','owner_id','r'),
 ('rent_payments','owner_insert_rent_payments','owner_id','a'),
 ('rent_payments','owner_update_rent_payments','owner_id','w'),
 ('rent_payments','owner_delete_rent_payments','owner_id','d'),
 ('announcements','owner_select_announcements','owner_id','r'),
 ('announcements','owner_insert_announcements','owner_id','a'),
 ('announcements','owner_update_announcements','owner_id','w'),
 ('announcements','owner_delete_announcements','owner_id','d'),
 ('notification_prefs','own_update_notification_prefs','user_id','w'),
 ('push_tokens','own_select_push_tokens','user_id','r'),
 ('push_tokens','own_delete_push_tokens','user_id','d'),
 ('notification_prefs','own_select_notification_prefs','user_id','r'),
 ('notification_prefs','own_insert_notification_prefs','user_id','a'),
 ('notification_prefs','own_delete_notification_prefs','user_id','d');
do $$
declare item record; actor_id text; predicate text; equivalent boolean; comparisons integer:=0;
begin
 perform pg_temp.assert_true((select count(*)=68 from rls_perf_expected),'exactly 68 reviewed policies tested');
 foreach actor_id in array array[
   'd6100000-0000-4000-8000-000000000001','d6100000-0000-4000-8000-000000000002',
   'd6100000-0000-4000-8000-000000000003','d6100000-0000-4000-8000-000000000004',
   'd6100000-0000-4000-8000-000000000005',null] loop
  perform pg_temp.actor(actor_id);
  for item in select e.*,p.polcmd,pg_get_expr(p.polqual,p.polrelid) as old_using,
      pg_get_expr(p.polwithcheck,p.polrelid) as old_check
    from rls_perf_expected e left join pg_policy p on
      p.polrelid=to_regclass(format('public.%I',e.table_name)) and p.polname=e.policy_name loop
   perform pg_temp.assert_true(item.polcmd::text=item.command,'reviewed policy and command exist: '||item.policy_name);
   for predicate in select unnest(array[item.old_using,item.old_check]) loop
    if predicate is null then continue; end if;
    perform pg_temp.assert_true(regexp_replace(lower(predicate),'\s','','g')=
      format('(%s=(selectauth.uid()asuid))',item.column_name),'only identity read was optimized: '||item.policy_name);
    execute format('select bool_and((%I=auth.uid()) is not distinct from (%s)) from (values ($1::uuid),($2::uuid),($3::uuid),(null::uuid)) fixture(%I)',
      item.column_name,predicate,item.column_name) into equivalent
      using 'd6100000-0000-4000-8000-000000000001','d6100000-0000-4000-8000-000000000002','d6100000-0000-4000-8000-000000000003';
    perform pg_temp.assert_true(equivalent,'original and optimized predicate differ: '||item.policy_name);
    comparisons:=comparisons+1;
   end loop;
  end loop;
 end loop;
 perform pg_temp.assert_true(comparisons=504,'all 84 predicates × six identities × four row-value cases compared');
 raise notice 'RLS predicate evidence: 68 policies, 84 predicates, 504 comparisons, 2016 row-value cases';
 perform pg_temp.actor(null);
end $$;


set local role authenticated;
prepare rentview_rls_perf_owner_read as
 select coalesce(array_agg(id order by id),'{}'::uuid[]) from public.properties
 where id between 'd6200000-0000-4000-8000-000000000001' and 'd6200000-0000-4000-8000-000000000005';
select pg_temp.actor('d6100000-0000-4000-8000-000000000001');
select pg_temp.expect_prepared(array['d6200000-0000-4000-8000-000000000001']::uuid[],'prepared owner A sees only A');
select pg_temp.actor('d6100000-0000-4000-8000-000000000002');
select pg_temp.expect_prepared(array['d6200000-0000-4000-8000-000000000002']::uuid[],'same prepared plan refreshes owner B identity');
select pg_temp.actor('d6100000-0000-4000-8000-000000000003');
select pg_temp.expect_prepared('{}'::uuid[],'tenant cannot inherit prior owner plan identity');
select pg_temp.assert_true((select count(*)=1 and bool_and(lease_id='d6400000-0000-4000-8000-000000000001') from public.tenant_lease_details),'tenant projection remains scoped');
select pg_temp.assert_true((select count(*)=1 and bool_and(id='d6500000-0000-4000-8000-000000000001') from public.rent_payments),'tenant rent membership remains scoped');
select pg_temp.assert_true((select count(*)=2 and bool_and(owner_id='d6100000-0000-4000-8000-000000000001') from public.announcements),'property and portfolio notices preserve tenant lane');
select pg_temp.actor(null);
select pg_temp.expect_prepared('{}'::uuid[],'missing identity cannot inherit prepared plan identity');
select pg_temp.assert_true(not public.current_account_is_active(),'missing identity is not active');
select pg_temp.actor('d6100000-0000-4000-8000-000000000004');
select pg_temp.expect_prepared(array['d6200000-0000-4000-8000-000000000004']::uuid[],'deletion fixture is accessible before deletion starts');
reset role;
select pg_temp.actor(null);
select public.prepare_identity_deletion('d6100000-0000-4000-8000-000000000004');
delete from auth.users where id='d6100000-0000-4000-8000-000000000005';
set local role authenticated;
select pg_temp.actor('d6100000-0000-4000-8000-000000000004');
select pg_temp.expect_prepared('{}'::uuid[],'same prepared plan denies deleting owner despite matching persisted row');
select pg_temp.assert_true(not public.current_account_is_active(),'deleting identity is inactive');
select pg_temp.assert_true((select count(*)=0 from public.notification_prefs),'restrictive account state still denies own preferences');
select pg_temp.expect_error($q$insert into public.notification_prefs(user_id) values('d6100000-0000-4000-8000-000000000004')$q$,'42501');
select pg_temp.actor('d6100000-0000-4000-8000-000000000005');
select pg_temp.expect_prepared('{}'::uuid[],'stale deleted-user token cannot inherit prepared identity');
select pg_temp.assert_true(not public.current_account_is_active(),'deleted identity is inactive');
select pg_temp.actor('d6100000-0000-4000-8000-000000000001');
select pg_temp.expect_prepared(array['d6200000-0000-4000-8000-000000000001']::uuid[],'prepared plan returns to owner A after denied actors');
select pg_temp.assert_true((select count(*)=1 and bool_and(id=auth.uid()) from public.profiles),'self profile read remains scoped');
select pg_temp.assert_true((select count(*)=1 and bool_and(user_id=auth.uid()) from public.notification_prefs),'self preference read remains scoped');
select pg_temp.assert_true((select count(*)=1 and bool_and(user_id=auth.uid()) from public.push_tokens),'self device read remains scoped');
with changed as (update public.notification_prefs set messages=false where user_id=auth.uid() returning *)
 select pg_temp.assert_true((select count(*)=1 and bool_and(not messages) from changed),'own preference update succeeds');
with changed as (update public.notification_prefs set messages=false where user_id='d6100000-0000-4000-8000-000000000002' returning *)
 select pg_temp.assert_true((select count(*)=0 from changed),'foreign preference update denied');
select pg_temp.expect_error($q$insert into public.notification_prefs(user_id) values('d6100000-0000-4000-8000-000000000003')$q$,'42501');
with removed as (delete from public.notification_prefs where user_id='d6100000-0000-4000-8000-000000000002' returning *)
 select pg_temp.assert_true((select count(*)=0 from removed),'foreign preference delete denied');
with removed as (delete from public.notification_prefs where user_id=auth.uid() returning *)
 select pg_temp.assert_true((select count(*)=1 from removed),'own preference delete succeeds');
insert into public.notification_prefs(user_id,messages) values('d6100000-0000-4000-8000-000000000001',false);
with removed as (delete from public.push_tokens where user_id='d6100000-0000-4000-8000-000000000002' returning *)
 select pg_temp.assert_true((select count(*)=0 from removed),'foreign device delete denied');
with removed as (delete from public.push_tokens where user_id=auth.uid() returning *)
 select pg_temp.assert_true((select count(*)=1 from removed),'own device delete succeeds');
with changed as (update public.properties set name='RLS changed A' where id='d6200000-0000-4000-8000-000000000001' returning *)
 select pg_temp.assert_true((select count(*)=1 from changed),'own property update succeeds');
with changed as (update public.properties set name='RLS forged B' where id='d6200000-0000-4000-8000-000000000002' returning *)
 select pg_temp.assert_true((select count(*)=0 from changed),'foreign property update denied');
select pg_temp.expect_error($q$insert into public.properties(owner_id,name) values('d6100000-0000-4000-8000-000000000002','RLS forged insert')$q$,'42501');
insert into public.properties(id,owner_id,name) values('d6200000-0000-4000-8000-000000000006','d6100000-0000-4000-8000-000000000001','RLS own insert');
with removed as (delete from public.properties where id='d6200000-0000-4000-8000-000000000006' returning *)
 select pg_temp.assert_true((select count(*)=1 from removed),'own property delete succeeds');
with removed as (delete from public.properties where id='d6200000-0000-4000-8000-000000000002' returning *)
 select pg_temp.assert_true((select count(*)=0 from removed),'foreign property delete denied');

-- Measure the actual plan rather than infer caching from SQL spelling.
do $$ declare plan jsonb; begin
 execute $query$explain (analyze,verbose,format json,timing off,costs off)
   select id from public.properties where id in
    ('d6200000-0000-4000-8000-000000000001','d6200000-0000-4000-8000-000000000002')$query$ into plan;
 perform pg_temp.assert_true((plan->0->'Plan'->>'Actual Rows')::int=1,'analyzed owner query returns exactly one scoped row');
 perform pg_temp.assert_true(exists(select 1 from pg_temp.plan_nodes(plan->0->'Plan') node
   where node->>'Parent Relationship'='InitPlan' and (node->>'Actual Loops')::int=1
     and ((node->'Output')::text like '%auth.uid()%' or (node->'Output')::text like '%request.jwt.claim.sub%')),
   'actual auth identity InitPlan executes once');
 perform pg_temp.assert_true(exists(select 1 from pg_temp.plan_nodes(plan->0->'Plan') node
   where node->>'Parent Relationship'='InitPlan' and (node->>'Actual Loops')::int=1
     and (node->'Output')::text like '%current_account_is_active()%'),
   'actual restrictive active-account InitPlan executes once');
 raise notice 'RLS analyzed plan evidence: %',plan;
end $$;

reset role;
set local role anon;
select pg_temp.actor(null);
select pg_temp.expect_error('execute rentview_rls_perf_owner_read','42501');
select pg_temp.expect_error('select * from public.profiles','42501');
select pg_temp.expect_error('select * from public.notification_prefs','42501');
select pg_temp.expect_error('select * from public.push_tokens','42501');
select pg_temp.expect_error('select * from public.tenant_lease_details','42501');
select pg_temp.expect_error('select * from public.announcements','42501');
reset role;
deallocate rentview_rls_perf_owner_read;
rollback;
