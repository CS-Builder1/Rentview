-- Disposable local PostgreSQL only. Entire fixture is rolled back.
-- Storage rows below are metadata-only dummy objects, never uploaded files.
begin;
set local statement_timeout='15s';
create function pg_temp.ok(value boolean,message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'Assertion failed: %',message; end if; end $$;
create function pg_temp.denied(statement text,state text) returns void language plpgsql as $$
begin
 begin execute statement;
 exception when others then
  if sqlstate=state then return; end if;
  raise exception 'Expected %, got %: %',state,sqlstate,sqlerrm;
 end;
 raise exception 'Expected failure: %',statement;
end $$;
create function pg_temp.actor(uid text) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',coalesce(uid,''),true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated')::text,true);
end $$;

-- Fixed server instants expose the exact calendar/year boundary, independent of
-- the test runner's current day or database TimeZone setting.
select pg_temp.ok(rentview_private.calendar_date_at('2027-01-01 03:30:00+00','America/Los_Angeles')='2026-12-31','late Dec31 expense stays in owner calendar year');
select pg_temp.ok(rentview_private.calendar_date_at('2026-12-31 11:30:00+00','Pacific/Kiritimati')='2027-01-01','UTC+14 owner already in next year');
select pg_temp.ok(rentview_private.calendar_date_at('2024-03-01 03:30:00+00','America/St_Lucia')='2024-02-29','leap-day boundary in St Lucia');
select pg_temp.denied($q$select rentview_private.calendar_date_at(now(),'UTC+10')$q$,'23514');
select pg_temp.denied($q$select rentview_private.calendar_date_at(now(),null)$q$,'23514');
select pg_temp.ok(not has_function_privilege('authenticated','rentview_private.calendar_date_at(timestamptz,text)','execute'),'private calendar helper not exposed');
select pg_temp.ok(not has_table_privilege('authenticated','rentview_private.identity_storage_cleanup','select'),'cleanup provenance not readable by clients');

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('e9100000-0000-4000-8000-000000000001','review-owner@example.test',now(),'{}'),
 ('e9100000-0000-4000-8000-000000000002','review-tenant@example.test',now(),'{}'),
 ('e9100000-0000-4000-8000-000000000003','review-foreign@example.test',now(),'{}');
insert into public.properties(id,owner_id,name) values
 ('e9200000-0000-4000-8000-000000000001','e9100000-0000-4000-8000-000000000001','Review operation fixture');
insert into public.units(id,owner_id,property_id,label) values
 ('e9300000-0000-4000-8000-000000000001','e9100000-0000-4000-8000-000000000001','e9200000-0000-4000-8000-000000000001','Review unit');
insert into public.leases(id,owner_id,unit_id,tenant_name,tenant_user_id,status) values
 ('e9400000-0000-4000-8000-000000000001','e9100000-0000-4000-8000-000000000001','e9300000-0000-4000-8000-000000000001','Review tenant','e9100000-0000-4000-8000-000000000002','active');
insert into public.work_orders(id,owner_id,property_id,unit_id,title,status) values
 ('e9500000-0000-4000-8000-000000000001','e9100000-0000-4000-8000-000000000001','e9200000-0000-4000-8000-000000000001','e9300000-0000-4000-8000-000000000001','Still open','in_progress'),
 ('e9500000-0000-4000-8000-000000000002','e9100000-0000-4000-8000-000000000001','e9200000-0000-4000-8000-000000000001','e9300000-0000-4000-8000-000000000001','Local cost date','open');
insert into public.maintenance_requests(id,owner_id,property_id,unit_id,lease_id,tenant_user_id,title,status,work_order_id,resolved_at) values
 ('e9600000-0000-4000-8000-000000000001','e9100000-0000-4000-8000-000000000001','e9200000-0000-4000-8000-000000000001','e9300000-0000-4000-8000-000000000001','e9400000-0000-4000-8000-000000000001','e9100000-0000-4000-8000-000000000002','Owner marked resolved early','resolved','e9500000-0000-4000-8000-000000000001',now());
insert into public.maintenance_schedules(id,owner_id,property_id,title,frequency,next_due,cadence) values
 ('e9700000-0000-4000-8000-000000000001','e9100000-0000-4000-8000-000000000001','e9200000-0000-4000-8000-000000000001','Edited month-end','monthly','2020-01-31','scheduled'),
 ('e9700000-0000-4000-8000-000000000002','e9100000-0000-4000-8000-000000000001','e9200000-0000-4000-8000-000000000001','Local today','daily',null,'completion');

select pg_temp.actor('e9100000-0000-4000-8000-000000000002');
set local role authenticated;
select public.reopen_tenant_request('e9600000-0000-4000-8000-000000000001','It is still leaking');
select pg_temp.ok((select status='acknowledged' and work_order_id='e9500000-0000-4000-8000-000000000001' from public.maintenance_requests where id='e9600000-0000-4000-8000-000000000001'),'reopening unfinished job retains link');
select pg_temp.actor('e9100000-0000-4000-8000-000000000001');
select pg_temp.ok(public.convert_request_to_work_order('e9600000-0000-4000-8000-000000000001')='e9500000-0000-4000-8000-000000000001','conversion reuses unfinished job');
select pg_temp.ok((select count(*)=2 from public.work_orders where owner_id=auth.uid()),'no duplicate job from reopened unfinished repair');
select public.complete_maintenance_schedule('e9700000-0000-4000-8000-000000000001','2020-01-31',null,'Pacific/Kiritimati');
select public.complete_maintenance_schedule('e9700000-0000-4000-8000-000000000001','2020-02-29',null,'America/Los_Angeles');
select pg_temp.ok((select next_due='2020-03-31' and anchor_day=31 from public.maintenance_schedules where id='e9700000-0000-4000-8000-000000000001'),'completion preserves original month-end anchor');
update public.maintenance_schedules set next_due='2020-04-15' where id='e9700000-0000-4000-8000-000000000001';
select pg_temp.ok((select anchor_day=15 from public.maintenance_schedules where id='e9700000-0000-4000-8000-000000000001'),'manual date edit resets anchor');
select public.complete_maintenance_schedule('e9700000-0000-4000-8000-000000000001','2020-04-15',null,'UTC');
select pg_temp.ok((select next_due='2020-05-15' and anchor_day=15 from public.maintenance_schedules where id='e9700000-0000-4000-8000-000000000001'),'edited cadence does not snap back to old day');
update public.maintenance_schedules set is_active=false where id='e9700000-0000-4000-8000-000000000001';
select pg_temp.ok((select anchor_day=15 from public.maintenance_schedules where id='e9700000-0000-4000-8000-000000000001'),'pause does not reset anchor');
select public.complete_maintenance_schedule('e9700000-0000-4000-8000-000000000002',(statement_timestamp() at time zone 'Pacific/Kiritimati')::date,null,'Pacific/Kiritimati');
select pg_temp.ok((select last_done=(statement_timestamp() at time zone 'Pacific/Kiritimati')::date from public.maintenance_schedules where id='e9700000-0000-4000-8000-000000000002'),'local today east of UTC accepted');
select pg_temp.denied($q$select public.complete_maintenance_schedule('e9700000-0000-4000-8000-000000000002',(statement_timestamp() at time zone 'Pacific/Kiritimati')::date+1,null,'Pacific/Kiritimati')$q$,'23514');
select public.complete_work_order('e9500000-0000-4000-8000-000000000002',1,'USD','Local expense',false,'America/Los_Angeles');
select pg_temp.ok((select incurred_on=(statement_timestamp() at time zone 'America/Los_Angeles')::date from public.expenses where work_order_id='e9500000-0000-4000-8000-000000000002'),'posted expense uses chosen calendar with server time');
select pg_temp.denied($q$select public.complete_work_order('e9500000-0000-4000-8000-000000000001',1,'USD',null,false,'Invented/Zone')$q$,'23514');
reset role;
select pg_temp.actor(null);
update public.work_orders set status='completed' where id='e9500000-0000-4000-8000-000000000001';
select pg_temp.actor('e9100000-0000-4000-8000-000000000002');
set local role authenticated;
select public.reopen_tenant_request('e9600000-0000-4000-8000-000000000001','The completed repair failed');
select pg_temp.ok((select status='submitted' and work_order_id is null from public.maintenance_requests where id='e9600000-0000-4000-8000-000000000001'),'completed history starts new triage');
reset role;
select pg_temp.actor(null);

-- Ownership provenance protects legacy/null uploader metadata cleanup.
insert into public.request_photos(request_id,storage_path,uploaded_by) values
 ('e9600000-0000-4000-8000-000000000001','requests/e9600000-0000-4000-8000-000000000001/legacy.jpg',null),
 ('e9600000-0000-4000-8000-000000000001','requests/e9600000-0000-4000-8000-000000000001/foreign.jpg',null),
 ('e9600000-0000-4000-8000-000000000001','requests/e9600000-0000-4000-8000-000000000001/replacement.jpg',null);
insert into storage.objects(bucket_id,name,owner,owner_id) values
 ('attachments','requests/e9600000-0000-4000-8000-000000000001/legacy.jpg','e9100000-0000-4000-8000-000000000002',null),
 ('attachments','requests/e9600000-0000-4000-8000-000000000001/foreign.jpg',null,'e9100000-0000-4000-8000-000000000003'),
 ('attachments','requests/e9600000-0000-4000-8000-000000000001/replacement.jpg','e9100000-0000-4000-8000-000000000002',null);
select public.prepare_identity_deletion('e9100000-0000-4000-8000-000000000002');
select pg_temp.ok(public.claim_identity_deletion_worker('e9100000-0000-4000-8000-000000000002','e9800000-0000-4000-8000-000000000001')='claimed','exclusive cleanup worker claimed');
select pg_temp.ok((select count(*)=2 and bool_and(name not like '%foreign.jpg') from public.owned_storage_paths('e9100000-0000-4000-8000-000000000002','e9800000-0000-4000-8000-000000000001',100)),'captured owned legacy object only');
select public.forget_deleted_uploads('e9100000-0000-4000-8000-000000000002','e9800000-0000-4000-8000-000000000001',array['requests/e9600000-0000-4000-8000-000000000001/legacy.jpg','requests/e9600000-0000-4000-8000-000000000001/foreign.jpg']);
select pg_temp.ok((select count(*)=3 from public.request_photos where request_id='e9600000-0000-4000-8000-000000000001'),'metadata retained while objects still exist');
-- Metadata-only dummy fixture: emulate successful Storage remove, rolled back.
set local storage.allow_delete_query='true';
delete from storage.objects where bucket_id='attachments' and name in ('requests/e9600000-0000-4000-8000-000000000001/legacy.jpg','requests/e9600000-0000-4000-8000-000000000001/replacement.jpg');
insert into storage.objects(bucket_id,name,owner_id) values
 ('attachments','requests/e9600000-0000-4000-8000-000000000001/replacement.jpg','e9100000-0000-4000-8000-000000000003');
select pg_temp.ok((select count(*)=0 from public.owned_storage_paths('e9100000-0000-4000-8000-000000000002','e9800000-0000-4000-8000-000000000001',100)),'response-loss retry never re-removes absent or foreign replacement paths');
select pg_temp.ok((select count(*)=1 from storage.objects where bucket_id='attachments' and name='requests/e9600000-0000-4000-8000-000000000001/replacement.jpg' and owner_id='e9100000-0000-4000-8000-000000000003'),'foreign replacement object preserved');
select public.forget_deleted_uploads('e9100000-0000-4000-8000-000000000002','e9800000-0000-4000-8000-000000000001',array['requests/e9600000-0000-4000-8000-000000000001/legacy.jpg','requests/e9600000-0000-4000-8000-000000000001/foreign.jpg']);
select pg_temp.ok((select count(*)=2 and bool_and(storage_path not like '%legacy.jpg') from public.request_photos where request_id='e9600000-0000-4000-8000-000000000001'),'only proven removed photo metadata is forgotten');
select pg_temp.ok((select count(*)=0 from public.owned_storage_paths('e9100000-0000-4000-8000-000000000002','e9800000-0000-4000-8000-000000000001',100)),'cleanup manifest exhausted after metadata ack');
select pg_temp.ok((select count(*)=1 from public.maintenance_requests where id='e9600000-0000-4000-8000-000000000001'),'repair history retained');

-- Quota counts text and legacy ownership consistently. Two users' files cannot
-- consume each other's quota; only the uploader's 101st attempt is rejected.
insert into storage.objects(bucket_id,name,owner_id)
 select 'attachments','e9100000-0000-4000-8000-000000000001/fixtures/'||n||'.txt','e9100000-0000-4000-8000-000000000001' from generate_series(1,99) n;
insert into storage.objects(bucket_id,name,owner,owner_id) values
 ('attachments','e9100000-0000-4000-8000-000000000001/fixtures/100.txt','e9100000-0000-4000-8000-000000000001',null);
select pg_temp.actor('e9100000-0000-4000-8000-000000000001');
select pg_temp.denied($q$insert into storage.objects(bucket_id,name,owner_id) values('attachments','e9100000-0000-4000-8000-000000000001/fixtures/101.txt','e9100000-0000-4000-8000-000000000001')$q$,'54000');
select pg_temp.actor('e9100000-0000-4000-8000-000000000003');
insert into storage.objects(bucket_id,name,owner_id) values
 ('attachments','e9100000-0000-4000-8000-000000000003/fixtures/2.txt','e9100000-0000-4000-8000-000000000003');
set local enable_seqscan=off;
do $$ declare plan jsonb; begin
 execute $q$explain (format json) select count(*) from storage.objects
  where coalesce(nullif(owner_id,''),owner::text)='e9100000-0000-4000-8000-000000000001'
   and created_at>now()-interval '1 minute'$q$ into plan;
 perform pg_temp.ok(plan::text like '%rentview_storage_owner_created_idx%','native owner quota expression can use bounded owner/time index');
end $$;
set constraints all immediate;
rollback;
