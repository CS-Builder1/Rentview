-- Self-contained rollback fixture for the release migration set, including inbox.
begin;
create function pg_temp.check_dispatch(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'Dispatch check failed: %',msg; end if; end $$;
create function pg_temp.dispatch_actor(n integer) returns void language plpgsql as $$
declare uid text:='dd000000-0000-4000-8000-'||lpad(n::text,12,'0');
begin
  perform set_config('request.jwt.claim.sub',uid,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated')::text,true);
end $$;
create function pg_temp.job() returns uuid language sql as $$select current_setting('fixture.job')::uuid$$;
create function pg_temp.revision() returns integer language sql as $$
  select revision from public.dispatch_jobs where work_order_id=pg_temp.job()
$$;
create function pg_temp.must_fail(stmt text) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then return; end;
  raise exception 'Expected rejected dispatch action: %',stmt;
end $$;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
  select ('dd000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'dispatch-'||n||'@example.test',now(),'{}'
  from generate_series(1,6) n;
insert into public.properties(id,owner_id,name) values
 ('dd100000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-000000000001','Dispatch test');
insert into public.units(id,owner_id,property_id,label) values('dd200000-0000-4000-8000-000000000001',
 'dd000000-0000-4000-8000-000000000001','dd100000-0000-4000-8000-000000000001','Test unit');
insert into public.leases(id,owner_id,unit_id,tenant_name,tenant_user_id,status) values (
 'dd300000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-000000000001','dd200000-0000-4000-8000-000000000001',
 'Resident','dd000000-0000-4000-8000-000000000002','active');
insert into public.vendors(id,owner_id,name,email) values
 ('dd400000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-000000000001','Plumber','dispatch-3@example.test'),
 ('dd400000-0000-4000-8000-000000000002','dd000000-0000-4000-8000-000000000001','Relief plumber','dispatch-5@example.test');
insert into public.maintenance_requests(id,owner_id,property_id,unit_id,lease_id,tenant_user_id,title,description)
 values('dd500000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-000000000001','dd100000-0000-4000-8000-000000000001',
 'dd200000-0000-4000-8000-000000000001','dd300000-0000-4000-8000-000000000001',
 'dd000000-0000-4000-8000-000000000002','Leaking sink','Water under sink');
insert into public.property_managers(property_id,user_id,email) values (
 'dd100000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-000000000006','dispatch-6@example.test');
select pg_temp.dispatch_actor(1);
set local role authenticated;
select set_config('fixture.code',public.create_contractor_invite('dd400000-0000-4000-8000-000000000001'),true);
select pg_temp.dispatch_actor(6);
select set_config('fixture.job',public.convert_request_to_work_order('dd500000-0000-4000-8000-000000000001')::text,true);
select pg_temp.check_dispatch(pg_temp.job()=public.convert_request_to_work_order('dd500000-0000-4000-8000-000000000001'),'manager retry reuses job');
select pg_temp.dispatch_actor(1);
update public.work_orders set description='Private landlord note' where id=pg_temp.job();
select public.assign_dispatch(pg_temp.job(),'dd400000-0000-4000-8000-000000000001','Use rear entrance');
select pg_temp.dispatch_actor(4);
select pg_temp.must_fail($q$select public.claim_contractor_invite(current_setting('fixture.code'))$q$);
select pg_temp.check_dispatch(not exists(select from public.dispatch_jobs where work_order_id=pg_temp.job()),'outside user cannot see repair');
select pg_temp.dispatch_actor(3);
select public.claim_contractor_invite(current_setting('fixture.code'));
select pg_temp.must_fail($q$select public.claim_contractor_invite(current_setting('fixture.code'))$q$);
select pg_temp.check_dispatch((select role='contractor' from public.profiles where id=auth.uid()),'claimed routing role');
select pg_temp.check_dispatch((select count(*)=1 from public.my_dispatch_jobs()),'authorized contractor queue');
select pg_temp.check_dispatch(not exists(select from public.work_orders where id=pg_temp.job()),'internal work order restricted');
select pg_temp.check_dispatch((select description='Water under sink' and instructions='Use rear entrance' and vendor_linked
  from public.dispatch_jobs where work_order_id=pg_temp.job()),'worker sees requested information only');
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'decline');
select pg_temp.check_dispatch(not exists(select from public.my_dispatch_jobs()),'declined offer removed');
select pg_temp.dispatch_actor(1);
select public.assign_dispatch(pg_temp.job(),'dd400000-0000-4000-8000-000000000001','Use rear entrance');
select pg_temp.dispatch_actor(3);
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'accept');
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'propose',now()+interval '1 day',now()+interval '1 day 2 hours');
select pg_temp.must_fail($q$select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'confirm')$q$);
select pg_temp.dispatch_actor(2);
select pg_temp.check_dispatch((select can_confirm from public.dispatch_jobs where work_order_id=pg_temp.job()),'resident can confirm provider slot');
select set_config('fixture.stale',pg_temp.revision()::text,true);
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'propose',now()+interval '2 days',now()+interval '2 days 1 hour');
select pg_temp.dispatch_actor(3);
select pg_temp.must_fail($q$select public.act_on_dispatch(pg_temp.job(),current_setting('fixture.stale')::int,'confirm')$q$);
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'confirm');
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'start');
select set_config('fixture.photo',pg_temp.job()::text||'/'||auth.uid()::text||'/washer.jpg',true);
insert into storage.objects(bucket_id,name,owner_id) values('dispatch-photos',current_setting('fixture.photo'),auth.uid()::text);
select pg_temp.must_fail($q$select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'complete',p_notes=>'Bad path',
  p_photos=>array['another-job/another-user/outside.jpg'])$q$);
select pg_temp.dispatch_actor(2);
select pg_temp.check_dispatch(not exists(select from storage.objects where bucket_id='dispatch-photos' and name=current_setting('fixture.photo')),
  'unsubmitted field photo private');
select pg_temp.dispatch_actor(3);
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'complete',p_notes=>'Replaced washer',p_photos=>array[current_setting('fixture.photo')]);
select pg_temp.dispatch_actor(2);
select pg_temp.check_dispatch((select status='resolved' from public.maintenance_requests
  where id='dd500000-0000-4000-8000-000000000001'),'physical completion resolves tenant report');
select pg_temp.check_dispatch(exists(select from storage.objects where bucket_id='dispatch-photos' and name=current_setting('fixture.photo')),
  'resident can read submitted completion proof');
select public.rate_request_resolution('dd500000-0000-4000-8000-000000000001',4,'Prompt');
select public.reopen_tenant_request('dd500000-0000-4000-8000-000000000001','Leak returned');
select pg_temp.check_dispatch((select assignment_status='accepted' and field_completed_at is null from public.dispatch_jobs where work_order_id=pg_temp.job()),'unposted field repair retained and reopened');
select pg_temp.dispatch_actor(3);
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'complete',p_notes=>'Replaced valve');
select pg_temp.dispatch_actor(1);
select pg_temp.check_dispatch((select status<>'completed' and completion_expense_id is null from public.work_orders where id=pg_temp.job()),'separate field and financial completion');
select public.complete_work_order(pg_temp.job(),30,'USD','Labor');
select pg_temp.check_dispatch(exists(select from public.dispatch_history where event='reopened' and detail->>'prior_rating'='4'),'prior rating retained');
select pg_temp.check_dispatch((select count(*)=2 from public.dispatch_history where work_order_id=pg_temp.job() and event='field_completed'),'both field completions retained');
select pg_temp.dispatch_actor(2);
select public.reopen_tenant_request('dd500000-0000-4000-8000-000000000001','Needs another repair');
select pg_temp.check_dispatch((select work_order_id is null and status='submitted' from public.maintenance_requests
  where id='dd500000-0000-4000-8000-000000000001'),'financially posted history immutable on tenant reopen');
select pg_temp.dispatch_actor(1);
select set_config('fixture.job',public.convert_request_to_work_order('dd500000-0000-4000-8000-000000000001')::text,true);
select public.assign_dispatch(pg_temp.job(),'dd400000-0000-4000-8000-000000000001');
select public.assign_dispatch(pg_temp.job(),'dd400000-0000-4000-8000-000000000002');
select pg_temp.dispatch_actor(3);
select pg_temp.check_dispatch(not exists(select from public.my_dispatch_jobs() where work_order_id=pg_temp.job()),'reassigned worker loses access');
select pg_temp.must_fail($q$select public.act_on_dispatch(pg_temp.job(),1,'accept')$q$);
reset role;
select pg_temp.check_dispatch(exists(select from public.inbox_events
  where recipient_id='dd000000-0000-4000-8000-000000000003' and href like '/contractor/job/%'),'durable worker assignment alerts');
select pg_temp.check_dispatch(exists(select from public.inbox_events
  where recipient_id='dd000000-0000-4000-8000-000000000002' and title='Visit proposed'),'resident visit alert');
set constraints all immediate;
rollback;
