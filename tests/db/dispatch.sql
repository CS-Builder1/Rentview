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
insert into public.vendors(id,owner_id,property_id,name) values('dd400000-0000-4000-8000-000000000003',
 'dd000000-0000-4000-8000-000000000001','dd100000-0000-4000-8000-000000000001','Property vendor');
select pg_temp.dispatch_actor(1);
set local role authenticated;
select pg_temp.check_dispatch(public.contractor_invitation_status('dd400000-0000-4000-8000-000000000001')='available','owner sees unlinked vendor');

select set_config('fixture.code',public.create_contractor_invite('dd400000-0000-4000-8000-000000000001'),true);
select pg_temp.check_dispatch(public.contractor_invitation_status('dd400000-0000-4000-8000-000000000001')='pending','issued invitation is pending');
select pg_temp.dispatch_actor(6);
select pg_temp.check_dispatch(public.contractor_invitation_status('dd400000-0000-4000-8000-000000000003')='available','assigned manager sees property vendor');
select pg_temp.check_dispatch(public.contractor_invitation_status('dd400000-0000-4000-8000-000000000001') is null,'manager cannot see owner-private vendor status');
select set_config('fixture.job',public.convert_request_to_work_order('dd500000-0000-4000-8000-000000000001')::text,true);
select pg_temp.check_dispatch(pg_temp.job()=public.convert_request_to_work_order('dd500000-0000-4000-8000-000000000001'),'manager retry reuses job');
select pg_temp.dispatch_actor(1);
update public.work_orders set description='Check braided inlet and replace if needed' where id=pg_temp.job();
select public.assign_dispatch(pg_temp.job(),'dd400000-0000-4000-8000-000000000001','Use rear entrance');
select pg_temp.dispatch_actor(4);
select pg_temp.check_dispatch(public.contractor_invitation_status('dd400000-0000-4000-8000-000000000003') is null,'unrelated account cannot see property vendor status');
select pg_temp.must_fail($q$select public.claim_contractor_invite(current_setting('fixture.code'))$q$);
select pg_temp.check_dispatch(not exists(select from public.dispatch_jobs where work_order_id=pg_temp.job()),'outside user cannot see repair');
select pg_temp.dispatch_actor(3);
select public.claim_contractor_invite(current_setting('fixture.code'));
select pg_temp.dispatch_actor(1);
select pg_temp.check_dispatch(public.contractor_invitation_status('dd400000-0000-4000-8000-000000000001')='connected','owner sees current confirmed link');
select pg_temp.dispatch_actor(3);
select pg_temp.must_fail($q$select public.claim_contractor_invite(current_setting('fixture.code'))$q$);
select pg_temp.check_dispatch((select role='contractor' from public.profiles where id=auth.uid()),'claimed routing role');
select pg_temp.check_dispatch((select count(*)=1 from public.my_dispatch_jobs()),'authorized contractor queue');
select pg_temp.check_dispatch(not exists(select from public.work_orders where id=pg_temp.job()),'internal work order restricted');
select pg_temp.check_dispatch((select description='Check braided inlet and replace if needed' and instructions='Use rear entrance' and vendor_linked
  from public.dispatch_jobs where work_order_id=pg_temp.job()),'worker sees requested information only');
savepoint extra_roles;
select public.contractor_open_owner_workspace();
select pg_temp.check_dispatch((select role='owner' from public.profiles where id=auth.uid()),'contractor can open landlord workspace');
select pg_temp.check_dispatch(exists(select from public.my_dispatch_jobs()),'landlord workspace keeps worker assignments');
rollback to extra_roles;
select pg_temp.dispatch_actor(1);
insert into public.leases(id,owner_id,unit_id,tenant_name,tenant_email,status) values (
 'dd300000-0000-4000-8000-000000000099',auth.uid(),'dd200000-0000-4000-8000-000000000001','Worker as tenant','dispatch-3@example.test','active');
select set_config('fixture.code2',(public.create_tenant_invite('dd300000-0000-4000-8000-000000000099','dispatch-3@example.test')).code,true);
select pg_temp.dispatch_actor(3);
select public.claim_tenant_invite(current_setting('fixture.code2'));
select pg_temp.check_dispatch((select role='tenant' from public.profiles where id=auth.uid()) and exists(select from public.my_dispatch_jobs()),'new tenant routes to portal and keeps assigned work');
rollback to extra_roles;
select pg_temp.dispatch_actor(1);
insert into public.work_orders(id,owner_id,property_id,vendor_id,title,description) values
 ('dd600000-0000-4000-8000-000000000001',auth.uid(),'dd100000-0000-4000-8000-000000000001','dd400000-0000-4000-8000-000000000001','Manual job','Isolate the valve');
select pg_temp.dispatch_actor(3);
select pg_temp.check_dispatch(exists(select from public.my_dispatch_jobs() where description='Isolate the valve' and request_id is null),'manual job preserves work scope');
rollback to extra_roles;
select set_config('fixture.action_rev',pg_temp.revision()::text,true);
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'decline');
select pg_temp.check_dispatch(public.dispatch_action_saved(pg_temp.job(),current_setting('fixture.action_rev')::int,'decline'),'declined response recoverable without queue access');
select pg_temp.check_dispatch(not exists(select from public.my_dispatch_jobs()),'declined offer removed');
select pg_temp.dispatch_actor(1);
select pg_temp.check_dispatch(not public.dispatch_action_saved(pg_temp.job(),current_setting('fixture.action_rev')::int,'decline'),'receipt only visible to original actor');
update public.work_orders set status='cancelled' where id=pg_temp.job();
update public.work_orders set status='open' where id=pg_temp.job();
select pg_temp.check_dispatch((select assignment_status='declined' from public.dispatch_jobs where work_order_id=pg_temp.job()),'reopening cannot accept a previous decline');
select pg_temp.dispatch_actor(1);
select public.assign_dispatch(pg_temp.job(),'dd400000-0000-4000-8000-000000000001','Use rear entrance');
select pg_temp.dispatch_actor(3);
select set_config('fixture.action_rev',pg_temp.revision()::text,true);
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'accept');
select pg_temp.check_dispatch(public.dispatch_action_saved(pg_temp.job(),current_setting('fixture.action_rev')::int,'accept'),'accepted response recoverable');
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'propose',now()+interval '1 day',now()+interval '1 day 2 hours');
select pg_temp.must_fail($q$select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'confirm')$q$);
select pg_temp.dispatch_actor(2);
select pg_temp.check_dispatch((select can_confirm and description='Water under sink' and instructions is null from public.dispatch_jobs where work_order_id=pg_temp.job()),'resident can confirm and sees only tenant-facing scope');
savepoint archived_visit;
select pg_temp.dispatch_actor(6);
select public.revoke_lease_portal('dd300000-0000-4000-8000-000000000001',true);
select pg_temp.check_dispatch((select can_confirm from public.dispatch_jobs where work_order_id=pg_temp.job()),'manager can confirm after tenant leaves');
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'confirm');
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'propose',now()+interval '3 days',now()+interval '3 days 1 hour');
select pg_temp.dispatch_actor(3);
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'confirm');
rollback to archived_visit;
select set_config('fixture.stale',pg_temp.revision()::text,true);
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'propose',now()+interval '2 days',now()+interval '2 days 1 hour');
select pg_temp.dispatch_actor(3);
select pg_temp.must_fail($q$select public.act_on_dispatch(pg_temp.job(),current_setting('fixture.stale')::int,'confirm')$q$);
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'confirm');
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'start');
select set_config('fixture.photo',pg_temp.job()::text||'/'||auth.uid()::text||'/washer.jpg',true);
insert into storage.objects(bucket_id,name,owner_id) values('dispatch-photos',current_setting('fixture.photo'),auth.uid()::text);
select set_config('fixture.draft',pg_temp.job()::text||'/'||auth.uid()::text||'/unused.jpg',true);
insert into storage.objects(bucket_id,name,owner_id) values('dispatch-photos',current_setting('fixture.draft'),auth.uid()::text);
select set_config('fixture.abandoned',pg_temp.job()::text||'/'||auth.uid()::text||'/abandoned.jpg',true);
insert into storage.objects(bucket_id,name,owner_id) values('dispatch-photos',current_setting('fixture.abandoned'),auth.uid()::text);
set local storage.allow_delete_query='true';
-- Only the uploader can remove a draft, including after the job ends.
select pg_temp.dispatch_actor(1);
delete from storage.objects where bucket_id='dispatch-photos' and name=current_setting('fixture.draft');
select pg_temp.dispatch_actor(3);
select pg_temp.check_dispatch(exists(select from storage.objects where bucket_id='dispatch-photos' and name=current_setting('fixture.draft')),
  'management cannot read or delete unpublished draft');
select pg_temp.must_fail($q$select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'complete',p_notes=>'Bad path',
  p_photos=>array['another-job/another-user/outside.jpg'])$q$);
select pg_temp.dispatch_actor(2);
select pg_temp.check_dispatch(not exists(select from storage.objects where bucket_id='dispatch-photos' and name=current_setting('fixture.photo')),
  'unsubmitted field photo private');
select pg_temp.dispatch_actor(3);
select set_config('fixture.action_rev',pg_temp.revision()::text,true);
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'complete',p_notes=>'Replaced washer',p_photos=>array[current_setting('fixture.photo')]);
select pg_temp.check_dispatch(public.dispatch_action_saved(pg_temp.job(),current_setting('fixture.action_rev')::int,'complete','Replaced washer',array[current_setting('fixture.photo')]),'worker recovers exact saved completion');
select pg_temp.check_dispatch(not public.dispatch_action_saved(pg_temp.job(),current_setting('fixture.action_rev')::int,'complete','Different note',array[current_setting('fixture.photo')]),'different completion cannot be mistaken for own draft');
select pg_temp.dispatch_actor(2);
select pg_temp.check_dispatch((select status='resolved' from public.maintenance_requests
  where id='dd500000-0000-4000-8000-000000000001'),'physical completion resolves tenant report');
select pg_temp.check_dispatch(exists(select from storage.objects where bucket_id='dispatch-photos' and name=current_setting('fixture.photo')),
  'resident can read submitted completion proof');
select pg_temp.check_dispatch((select owner_id='dd000000-0000-4000-8000-000000000001' and owner='dd000000-0000-4000-8000-000000000001'
  from storage.objects where bucket_id='dispatch-photos' and name=current_setting('fixture.photo')), 'published proof belongs to portfolio');
select pg_temp.dispatch_actor(3);
delete from storage.objects where bucket_id='dispatch-photos' and name=current_setting('fixture.photo');
select pg_temp.dispatch_actor(2);
select pg_temp.check_dispatch(exists(select from storage.objects where bucket_id='dispatch-photos' and name=current_setting('fixture.photo')),
  'contractor cannot erase submitted proof');
select public.rate_request_resolution('dd500000-0000-4000-8000-000000000001',4,'Prompt');
select pg_temp.dispatch_actor(1);
update public.work_orders set status='on_hold' where id=pg_temp.job();
select pg_temp.check_dispatch((select status='resolved' and rating=4 from public.maintenance_requests where work_order_id=pg_temp.job()),'administrative field status preserves rating');
select pg_temp.check_dispatch((select completion_notes='Replaced washer' and assignment_status='completed' from public.dispatch_jobs where work_order_id=pg_temp.job()),'administrative field status preserves proof');
savepoint remove_contact;
reset role;
select set_config('fixture.events',(select count(*)::text from public.inbox_events),true);
set local role authenticated;
delete from public.vendors where id='dd400000-0000-4000-8000-000000000001';
select pg_temp.dispatch_actor(2);
select pg_temp.check_dispatch((select vendor_id is null and vendor_name='Plumber' and completion_notes='Replaced washer' and current_setting('fixture.photo')=any(completion_photos) from public.dispatch_jobs where work_order_id=pg_temp.job()),'removing a vendor retains shared field evidence');
reset role;
select pg_temp.check_dispatch((select count(*)=current_setting('fixture.events')::int from public.inbox_events),'administrative vendor cleanup emits no assignment notices');
rollback to remove_contact;
select pg_temp.dispatch_actor(2);
select public.reopen_tenant_request('dd500000-0000-4000-8000-000000000001','Leak returned');
select pg_temp.check_dispatch((select assignment_status='accepted' and field_completed_at is null from public.dispatch_jobs where work_order_id=pg_temp.job()),'unposted field repair retained and reopened');
select pg_temp.dispatch_actor(3);
select public.act_on_dispatch(pg_temp.job(),pg_temp.revision(),'complete',p_notes=>'Replaced valve');
select pg_temp.dispatch_actor(1);
select pg_temp.check_dispatch((select status<>'completed' and completion_expense_id is null from public.work_orders where id=pg_temp.job()),'separate field and financial completion');
select public.complete_work_order(pg_temp.job(),30,'USD','Labor');
savepoint delete_posted_contact;
delete from public.vendors where id='dd400000-0000-4000-8000-000000000001';
select pg_temp.check_dispatch((select assignment_status='completed' and completion_notes='Replaced valve' and vendor_name='Plumber' from public.dispatch_jobs where work_order_id=pg_temp.job()),'posted job retains completed dispatch and historical contractor');
rollback to delete_posted_contact;
select pg_temp.check_dispatch(exists(select from public.dispatch_history where event='reopened' and detail->>'prior_rating'='4'),'prior rating retained');
select pg_temp.check_dispatch((select count(*)=2 from public.dispatch_history where work_order_id=pg_temp.job() and event='field_completed'),'both field completions retained');
select pg_temp.dispatch_actor(2);
reset role;
select set_config('fixture.worker_events',(select count(*)::text from public.inbox_events where recipient_id='dd000000-0000-4000-8000-000000000003'),true);
set local role authenticated;
select public.reopen_tenant_request('dd500000-0000-4000-8000-000000000001','Needs another repair');
reset role;
select pg_temp.check_dispatch((select count(*)=current_setting('fixture.worker_events')::int from public.inbox_events where recipient_id='dd000000-0000-4000-8000-000000000003'),'terminal follow-up sends no worker alerts');
select pg_temp.check_dispatch(exists(select from public.dispatch_history where work_order_id=pg_temp.job() and detail->>'reason'='Needs another repair'),'terminal follow-up remains in history');
set local role authenticated;
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
-- The historical binding survives both the operational record and uploader.
set local role authenticated;
select pg_temp.dispatch_actor(1);
select public.offer_portfolio_transfer('dd000000-0000-4000-8000-000000000006');
select pg_temp.dispatch_actor(6);
select public.accept_portfolio_transfer('dd000000-0000-4000-8000-000000000001');
select pg_temp.check_dispatch((select owner_id=auth.uid()::text and owner=auth.uid() from storage.objects
  where bucket_id='dispatch-photos' and name=current_setting('fixture.photo')), 'published proof transferred to successor');
select pg_temp.dispatch_actor(1);
select pg_temp.check_dispatch(not exists(select from storage.objects where bucket_id='dispatch-photos' and name=current_setting('fixture.photo')),
  'outgoing owner loses proof access');
select pg_temp.dispatch_actor(3);
select pg_temp.check_dispatch((select owner_id=auth.uid()::text from storage.objects where bucket_id='dispatch-photos' and name=current_setting('fixture.draft')),
  'handover leaves unpublished draft with uploader');
delete from storage.objects where bucket_id='dispatch-photos' and name=current_setting('fixture.draft');
select pg_temp.check_dispatch(not exists(select from storage.objects where bucket_id='dispatch-photos' and name=current_setting('fixture.draft')),
  'uploader removes unpublished draft after job closed');
reset role;
select public.prepare_identity_deletion('dd000000-0000-4000-8000-000000000003');
select public.claim_identity_deletion_worker('dd000000-0000-4000-8000-000000000003','dd900000-0000-4000-8000-000000000003');
select pg_temp.check_dispatch(not exists(select from public.owned_storage_paths('dd000000-0000-4000-8000-000000000003',
  'dd900000-0000-4000-8000-000000000003',100) where bucket_id='dispatch-photos' and name=current_setting('fixture.photo')),
  'deletion worker excludes property-owned evidence');
select pg_temp.check_dispatch(exists(select from public.owned_storage_paths('dd000000-0000-4000-8000-000000000003',
  'dd900000-0000-4000-8000-000000000003',100) where bucket_id='dispatch-photos' and name=current_setting('fixture.abandoned')),
  'deletion worker includes the departing user’s abandoned draft');
delete from storage.objects o using public.owned_storage_paths('dd000000-0000-4000-8000-000000000003',
  'dd900000-0000-4000-8000-000000000003',100) disposable where o.bucket_id=disposable.bucket_id and o.name=disposable.name;
delete from auth.users where id='dd000000-0000-4000-8000-000000000003';
-- Model removal of the live dispatch row without modifying a posted financial record.
delete from public.work_order_dispatch where work_order_id=split_part(current_setting('fixture.photo'),'/',1)::uuid;
set local role authenticated;
select pg_temp.dispatch_actor(6);
select pg_temp.check_dispatch(exists(select from storage.objects where bucket_id='dispatch-photos' and name=current_setting('fixture.photo')),
  'successor sees historical proof after contractor deletion and operational record removal');
select pg_temp.dispatch_actor(4);
select pg_temp.check_dispatch(not exists(select from storage.objects where bucket_id='dispatch-photos' and name=current_setting('fixture.photo')),
  'unrelated user cannot read historical proof');
reset role;
set constraints all immediate;
rollback;
