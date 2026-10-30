-- Run against a disposable migrated local database, never against production.
-- Every fixture and assertion is rolled back. A raised exception fails psql.
begin;
create function pg_temp.assert_true(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Assertion failed: %',message; end if; end $$;
create function pg_temp.expect_error(statement text,expected_state text) returns void language plpgsql as $$
begin
 begin execute statement;
 exception when others then
  if sqlstate=expected_state then return; end if;
  raise exception 'Expected SQLSTATE %, got %: %',expected_state,sqlstate,sqlerrm;
 end;
 raise exception 'Expected SQLSTATE %, but statement succeeded: %',expected_state,statement;
end $$;
create function pg_temp.actor(uid text) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',uid,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated')::text,true);
end $$;

insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
 ('00000000-0000-4000-8000-000000000001','owner-a@example.test','{}',now()),
 ('00000000-0000-4000-8000-000000000002','owner-b@example.test','{}',now()),
 ('00000000-0000-4000-8000-000000000003','tenant@example.test','{}',now()),
 ('00000000-0000-4000-8000-000000000004','other-tenant@example.test','{}',now()),
 ('00000000-0000-4000-8000-000000000005','unverified@example.test','{}',null);
insert into public.properties(id,owner_id,name) values
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Owner A building'),
 ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Owner B building');
insert into public.units(id,owner_id,property_id,label) values
 ('10000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Apt A'),
 ('20000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','Apt B');
insert into public.leases(id,owner_id,unit_id,tenant_name,tenant_email,status) values
 ('10000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000101','Fixture Tenant','tenant@example.test','active'),
 ('20000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000101','Other Tenant',null,'active');

select pg_temp.assert_true(not has_table_privilege('authenticated','public.subscriptions','INSERT'),'subscription INSERT revoked');
select pg_temp.assert_true(not has_table_privilege('authenticated','public.subscriptions','UPDATE'),'subscription UPDATE revoked');
select pg_temp.assert_true(not has_table_privilege('authenticated','public.subscriptions','DELETE'),'subscription DELETE revoked');
select pg_temp.assert_true(not has_function_privilege('anon','public.claim_tenant_invite(text)','EXECUTE'),'anonymous invite claim revoked');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.user_id_for_email(text)','EXECUTE'),'email lookup service-only');
select pg_temp.assert_true(not has_table_privilege('authenticated','public.work_order_parts','INSERT'),'stock mutation must use RPC');

set local role authenticated;
select pg_temp.actor('00000000-0000-4000-8000-000000000001');
select pg_temp.assert_true((select count(*)=1 from public.properties),'owner reads only own property');
select pg_temp.expect_error($q$insert into public.units(owner_id,property_id,label) values('00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Foreign unit')$q$,'23503');
select pg_temp.expect_error($q$update public.profiles set role='tenant' where id=auth.uid()$q$,'42501');
select pg_temp.expect_error($q$insert into public.subscriptions(owner_id,provider,plan,status) values(auth.uid(),'paypal','pro','active')$q$,'42501');
select pg_temp.expect_error($q$insert into public.tenant_invites(owner_id,lease_id,code) values(auth.uid(),'20000000-0000-4000-8000-000000000201','FOREIGNLEASE')$q$,'42501');
select pg_temp.expect_error($q$select public.create_tenant_invite('20000000-0000-4000-8000-000000000201',null)$q$,'42501');
select pg_temp.expect_error($q$update public.leases set tenant_user_id='00000000-0000-4000-8000-000000000004' where id='10000000-0000-4000-8000-000000000201'$q$,'42501');
select set_config('test.invite',(public.create_tenant_invite('10000000-0000-4000-8000-000000000201','tenant@example.test')).code,true);
select pg_temp.assert_true(length(current_setting('test.invite'))=32,'server invitation entropy');
select pg_temp.expect_error($q$select public.claim_tenant_invite(current_setting('test.invite'))$q$,'23514');
insert into public.properties(owner_id,name) values(auth.uid(),'Second property'),(auth.uid(),'Third property');
select pg_temp.expect_error($q$insert into public.properties(owner_id,name) values(auth.uid(),'Fourth property')$q$,'23514');
select pg_temp.expect_error($q$insert into public.properties(id,owner_id,name) values('10000000-0000-4000-8000-000000000001',auth.uid(),'Owner A building')$q$,'23505'); -- lost-ack retry at cap
select pg_temp.expect_error($q$insert into public.work_orders(owner_id,property_id,title,status) values(auth.uid(),'10000000-0000-4000-8000-000000000001','Forged completion','completed')$q$,'42501');

select pg_temp.actor('00000000-0000-4000-8000-000000000004');
select pg_temp.expect_error($q$select public.claim_tenant_invite(current_setting('test.invite'))$q$,'42501');
select pg_temp.actor('00000000-0000-4000-8000-000000000005');
select pg_temp.expect_error($q$select public.claim_tenant_invite(current_setting('test.invite'))$q$,'42501');
select pg_temp.actor('00000000-0000-4000-8000-000000000003');
select public.claim_tenant_invite(lower(current_setting('test.invite')));
select public.claim_tenant_invite(current_setting('test.invite')); -- lost-ack retry by same linked tenant
select pg_temp.assert_true((select role='tenant' from public.profiles where id=auth.uid()),'claim changes routing role');
select pg_temp.assert_true((select count(*)=1 from public.tenant_lease_details),'only own lease visible through tenant surface');
select pg_temp.assert_true((select count(*)=0 from public.leases),'tenant cannot read private lease rows');
with saved as (
 insert into public.maintenance_requests(id,owner_id,lease_id,unit_id,property_id,tenant_user_id,title) values
  ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000201','10000000-0000-4000-8000-000000000101','10000000-0000-4000-8000-000000000001',auth.uid(),'Fixture leaking tap')
 returning id
) select pg_temp.assert_true((select count(*)=1 and bool_and(id='30000000-0000-4000-8000-000000000001') from saved),'tenant creation supports same-command INSERT RETURNING');
select pg_temp.expect_error($q$insert into public.maintenance_requests(owner_id,lease_id,unit_id,property_id,tenant_user_id,title,status) values('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000201','10000000-0000-4000-8000-000000000101','10000000-0000-4000-8000-000000000001',auth.uid(),'Forged status','resolved')$q$,'42501');
with changed as (update public.maintenance_requests set owner_id='00000000-0000-4000-8000-000000000002',status='resolved' where id='30000000-0000-4000-8000-000000000001' returning *)
 select pg_temp.assert_true((select count(*)=0 from changed),'tenant cannot update internal request fields');
select pg_temp.expect_error($q$select public.rate_request_resolution('30000000-0000-4000-8000-000000000001',5,null)$q$,'23514');
select pg_temp.expect_error($q$select public.close_tenant_request('30000000-0000-4000-8000-000000000001')$q$,'23514');
insert into public.request_messages(request_id,sender_id,body) values('30000000-0000-4000-8000-000000000001',auth.uid(),'The tap is under the sink.');
select pg_temp.expect_error($q$insert into public.request_messages(request_id,sender_id,body) values('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Spoofed owner')$q$,'42501');
insert into public.request_photos(request_id,storage_path) values('30000000-0000-4000-8000-000000000001','requests/30000000-0000-4000-8000-000000000001/fixture.jpg');
select pg_temp.expect_error($q$insert into public.request_photos(request_id,storage_path) values('30000000-0000-4000-8000-000000000001','requests/foreign/fixture.jpg')$q$,'23514');
insert into storage.objects(bucket_id,name) values('attachments','requests/30000000-0000-4000-8000-000000000001/fixture.jpg');
select pg_temp.assert_true((select count(*)=1 from storage.objects where name like '%fixture.jpg'),'participant can read its request object');

select pg_temp.actor('00000000-0000-4000-8000-000000000004');
select pg_temp.assert_true((select count(*)=0 from public.maintenance_requests),'other tenant cannot read request');
select pg_temp.assert_true((select count(*)=0 from public.request_messages),'other tenant cannot read messages');
select pg_temp.expect_error($q$select public.close_tenant_request('30000000-0000-4000-8000-000000000001')$q$,'42501');

select pg_temp.actor('00000000-0000-4000-8000-000000000001');
select set_config('test.job',public.convert_request_to_work_order('30000000-0000-4000-8000-000000000001')::text,true);
select pg_temp.assert_true(public.convert_request_to_work_order('30000000-0000-4000-8000-000000000001')::text=current_setting('test.job'),'conversion retry returns same job');
select pg_temp.assert_true((select count(*)=1 from public.work_orders),'conversion creates exactly one job');
select pg_temp.expect_error($q$update public.maintenance_requests set rating=5 where id='30000000-0000-4000-8000-000000000001'$q$,'42501');
insert into public.inventory_items(id,owner_id,property_id,name,quantity,unit_cost,cost_currency) values
 ('10000000-0000-4000-8000-000000000301',auth.uid(),'10000000-0000-4000-8000-000000000001','Tap washer',5,2,'USD');
select pg_temp.expect_error($q$select public.add_work_order_part(current_setting('test.job')::uuid,'10000000-0000-4000-8000-000000000301',null,0.005,null,'USD','40000000-0000-4000-8000-000000000003')$q$,'23514');
select pg_temp.assert_true((select quantity=5 from public.inventory_items where id='10000000-0000-4000-8000-000000000301'),'sub-cent quantity cannot round away stock consumption');
select public.add_work_order_part(current_setting('test.job')::uuid,'10000000-0000-4000-8000-000000000301',null,0.01,null,'USD','40000000-0000-4000-8000-000000000003');
select pg_temp.assert_true((select quantity=4.99 from public.inventory_items where id='10000000-0000-4000-8000-000000000301'),'smallest supported quantity consumes exact stock');
select public.remove_work_order_part('40000000-0000-4000-8000-000000000003');
select pg_temp.assert_true((select quantity=5 from public.inventory_items where id='10000000-0000-4000-8000-000000000301'),'fractional consume/remove preserves stock');
select public.add_work_order_part(current_setting('test.job')::uuid,'10000000-0000-4000-8000-000000000301',null,2,null,'USD','40000000-0000-4000-8000-000000000001');
select public.add_work_order_part(current_setting('test.job')::uuid,'10000000-0000-4000-8000-000000000301',null,2,null,'USD','40000000-0000-4000-8000-000000000001');
select pg_temp.assert_true((select quantity=3 from public.inventory_items where id='10000000-0000-4000-8000-000000000301'),'stock consumed exactly once on retry');
select pg_temp.expect_error($q$select public.add_work_order_part(current_setting('test.job')::uuid,'10000000-0000-4000-8000-000000000301',null,3,null,'USD','40000000-0000-4000-8000-000000000001')$q$,'23514');
select pg_temp.expect_error($q$select public.add_work_order_part(current_setting('test.job')::uuid,'10000000-0000-4000-8000-000000000301',null,10,null,'USD',null)$q$,'23514');
select public.remove_work_order_part('40000000-0000-4000-8000-000000000001');
select public.remove_work_order_part('40000000-0000-4000-8000-000000000001');
select pg_temp.assert_true((select quantity=5 from public.inventory_items where id='10000000-0000-4000-8000-000000000301'),'removal restores stock exactly once');
select pg_temp.expect_error($q$select public.add_work_order_part(current_setting('test.job')::uuid,'10000000-0000-4000-8000-000000000301',null,2,null,'USD','40000000-0000-4000-8000-000000000001')$q$,'23514');
select public.add_work_order_part(current_setting('test.job')::uuid,'10000000-0000-4000-8000-000000000301',null,2,null,'USD','40000000-0000-4000-8000-000000000002');
select set_config('test.expense',public.complete_work_order(current_setting('test.job')::uuid,10,'USD','Replaced washer')::text,true);
select pg_temp.assert_true(public.complete_work_order(current_setting('test.job')::uuid,10,'USD','Replaced washer')::text=current_setting('test.expense'),'completion retry returns same expense');
select pg_temp.expect_error($q$select public.complete_work_order(current_setting('test.job')::uuid,11,'USD','Replaced washer')$q$,'23514'); -- changed retry cannot silently alter posted cost
select pg_temp.assert_true((select count(*)=1 from public.expenses where work_order_id=current_setting('test.job')::uuid),'one completion expense');
select pg_temp.assert_true((select amount=14 from public.expenses where id=current_setting('test.expense')::uuid),'parts plus labor posted correctly');
select pg_temp.expect_error($q$select public.remove_work_order_part('40000000-0000-4000-8000-000000000002')$q$,'23514');
select pg_temp.expect_error($q$update public.expenses set amount=1 where id=current_setting('test.expense')::uuid$q$,'23514');
insert into public.expenses(id,owner_id,property_id,category,description,amount,currency,incurred_on) values
 ('60000000-0000-4000-8000-000000000001',auth.uid(),'10000000-0000-4000-8000-000000000001','repair','Unlinked invoice',1,'USD',current_date);
select pg_temp.expect_error($q$update public.expenses set work_order_id=current_setting('test.job')::uuid where id='60000000-0000-4000-8000-000000000001'$q$,'23514');
select pg_temp.assert_true((select work_order_id is null from public.expenses where id='60000000-0000-4000-8000-000000000001'),'posted job rejects an existing unlinked expense');
select pg_temp.expect_error($q$update public.work_orders set status='open' where id=current_setting('test.job')::uuid$q$,'42501');

select pg_temp.actor('00000000-0000-4000-8000-000000000002');
select pg_temp.expect_error($q$select public.convert_request_to_work_order('30000000-0000-4000-8000-000000000001')$q$,'42501');
select pg_temp.expect_error($q$select public.complete_work_order(current_setting('test.job')::uuid,0,'USD',null)$q$,'42501');
select pg_temp.assert_true((select count(*)=0 from public.work_order_events),'other owner cannot read work history');

select pg_temp.actor('00000000-0000-4000-8000-000000000003');
select pg_temp.assert_true((select status='resolved' from public.maintenance_requests where id='30000000-0000-4000-8000-000000000001'),'completion mirrors tenant status');
select public.rate_request_resolution('30000000-0000-4000-8000-000000000001',4,'Fixed quickly');
select public.rate_request_resolution('30000000-0000-4000-8000-000000000001',4,'Fixed quickly');
select pg_temp.expect_error($q$select public.rate_request_resolution('30000000-0000-4000-8000-000000000001',5,'Changed')$q$,'23514');
select public.close_tenant_request('30000000-0000-4000-8000-000000000001');
select pg_temp.expect_error($q$insert into public.request_messages(request_id,sender_id,body) values('30000000-0000-4000-8000-000000000001',auth.uid(),'Closed write')$q$,'42501');
select pg_temp.expect_error($q$insert into public.request_photos(request_id,storage_path) values('30000000-0000-4000-8000-000000000001','requests/30000000-0000-4000-8000-000000000001/closed.jpg')$q$,'42501');
select public.reopen_tenant_request('30000000-0000-4000-8000-000000000001','The tap is leaking again.');
select pg_temp.assert_true((select status='submitted' and work_order_id is null and rating is null from public.maintenance_requests where id='30000000-0000-4000-8000-000000000001'),'reopen starts new triage, retaining old job');

select pg_temp.actor('00000000-0000-4000-8000-000000000001');
insert into public.maintenance_schedules(id,owner_id,property_id,title,frequency,next_due,cadence) values
 ('50000000-0000-4000-8000-000000000001',auth.uid(),'10000000-0000-4000-8000-000000000001','Month-end inspection','monthly','2020-01-31','scheduled');
select set_config('test.completion',public.complete_maintenance_schedule('50000000-0000-4000-8000-000000000001','2020-01-31','Done')::text,true);
select pg_temp.assert_true((select next_due='2020-02-29' from public.maintenance_schedules where id='50000000-0000-4000-8000-000000000001'),'leap month calendar recurrence');
select pg_temp.assert_true(public.complete_maintenance_schedule('50000000-0000-4000-8000-000000000001','2020-01-31','Done')::text=current_setting('test.completion'),'schedule replay returns same event');
select public.complete_maintenance_schedule('50000000-0000-4000-8000-000000000001','2020-02-29','Done');
select pg_temp.assert_true((select next_due='2020-03-31' from public.maintenance_schedules where id='50000000-0000-4000-8000-000000000001'),'fixed calendar preserves month-end anchor');
select pg_temp.assert_true((select count(*)=2 from public.maintenance_completions),'schedule history preserved without duplicate completion');
select pg_temp.expect_error($q$select public.complete_maintenance_schedule('50000000-0000-4000-8000-000000000001',current_date+1,null)$q$,'23514');

update public.leases set status='expired' where id='10000000-0000-4000-8000-000000000201';
select pg_temp.actor('00000000-0000-4000-8000-000000000003');
select pg_temp.assert_true((select count(*)=1 from public.maintenance_requests where id='30000000-0000-4000-8000-000000000001'),'inactive linked lease retains existing request history');
select pg_temp.assert_true((select count(*)>=1 from public.request_messages where request_id='30000000-0000-4000-8000-000000000001'),'inactive linked lease retains existing thread history');
select pg_temp.expect_error($q$insert into public.maintenance_requests(owner_id,lease_id,unit_id,property_id,tenant_user_id,title) values('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000201','10000000-0000-4000-8000-000000000101','10000000-0000-4000-8000-000000000001',auth.uid(),'New request on inactive lease') returning id$q$,'42501');
select pg_temp.actor('00000000-0000-4000-8000-000000000001');
update public.leases set tenant_user_id=null where id='10000000-0000-4000-8000-000000000201';
select pg_temp.actor('00000000-0000-4000-8000-000000000003');
select pg_temp.assert_true((select count(*)=0 from public.tenant_lease_details),'revoked tenant cannot read lease surface');
select pg_temp.assert_true((select count(*)=0 from public.maintenance_requests),'revoked tenant cannot read old request');
select pg_temp.assert_true((select count(*)=0 from public.request_messages),'revoked tenant cannot read thread');
select pg_temp.assert_true((select count(*)=0 from public.request_photos),'revoked tenant cannot read photos');
select pg_temp.assert_true((select count(*)=0 from storage.objects where name like '%fixture.jpg'),'revoked tenant cannot authorize new object reads');
select pg_temp.expect_error($q$select public.reopen_tenant_request('30000000-0000-4000-8000-000000000001','Again')$q$,'42501');
select pg_temp.expect_error($q$select public.register_push_token('not-a-token','ios')$q$,'23514');
select public.register_push_token('ExponentPushToken[fixture-device-token-123]','ios');
select public.register_push_token('ExponentPushToken[fixture-device-token-123]','ios');
select pg_temp.assert_true((select count(*)=1 from public.push_tokens),'push registration retry does not create extra devices');

reset role;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
delete from auth.users where id='00000000-0000-4000-8000-000000000003';
select pg_temp.assert_true((select tenant_user_id is null from public.maintenance_requests where id='30000000-0000-4000-8000-000000000001'),'identity deletion preserves anonymized request');
select pg_temp.assert_true((select count(*)>=2 from public.request_messages where request_id='30000000-0000-4000-8000-000000000001' and sender_id is null),'identity deletion preserves anonymized thread');

-- Service-context identity cleanup must remove both ends of a completed
-- job/expense history cycle. Force deferred checks before rollback so this
-- regression cannot pass merely because deferred constraints never ran.
select public.prepare_identity_deletion('00000000-0000-4000-8000-000000000001');
delete from auth.users where id='00000000-0000-4000-8000-000000000001';
set constraints all immediate;
select pg_temp.assert_true((select count(*)=0 from public.work_orders where owner_id='00000000-0000-4000-8000-000000000001'),'owner deletion removed completed jobs');
select pg_temp.assert_true((select count(*)=0 from public.expenses where owner_id='00000000-0000-4000-8000-000000000001'),'owner deletion removed completion expenses');
select pg_temp.assert_true((select count(*)=0 from public.work_order_events where owner_id='00000000-0000-4000-8000-000000000001'),'owner deletion removed its history');
select pg_temp.assert_true((select count(*)=1 from public.properties where owner_id='00000000-0000-4000-8000-000000000002'),'owner deletion preserved another portfolio');
rollback;
