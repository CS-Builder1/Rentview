-- Disposable local database. Exercise the same RPCs the inbox screens use.
begin;
create function pg_temp.actor(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',uid,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated')::text,true);
end $$;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
 ('72000000-0000-4000-8000-000000000001','inbox-owner@example.test','{}',now()),
 ('72000000-0000-4000-8000-000000000002','inbox-renter@example.test','{}',now()),
 ('72000000-0000-4000-8000-000000000003','inbox-staff@example.test','{}',now()),
 ('72000000-0000-4000-8000-000000000004','inbox-other@example.test','{}',now());
insert into public.properties(id,owner_id,name) values
 ('72100000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','Inbox House');
insert into public.property_managers(property_id,user_id,email) values
 ('72100000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000003','inbox-staff@example.test');
insert into public.units(id,owner_id,property_id,label) values
 ('72200000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','72100000-0000-4000-8000-000000000001','Unit 1');
insert into public.leases(id,owner_id,unit_id,tenant_user_id,tenant_name,status,start_date) values
 ('72300000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','72200000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000002','Fixture Renter','active',current_date);
set local role authenticated;
select pg_temp.actor('72000000-0000-4000-8000-000000000002');
do $$
declare l record; msg constant uuid:='72400000-0000-4000-8000-000000000001';
begin
  select * into strict l from public.inbox_leases();
  perform public.send_lease_message(l.lease_id,l.resident_id,msg,'Can I renew my lease?');
  perform public.send_lease_message(l.lease_id,l.resident_id,msg,'Can I renew my lease?');
  assert (select count(*)=1 from public.lease_thread(l.lease_id,l.resident_id));
  assert public.inbox_unread_count()=0;
end $$;
select pg_temp.actor('72000000-0000-4000-8000-000000000003');
do $$
declare l record;
begin
  select * into strict l from public.inbox_leases();
  assert l.unread=1 and l.last_message='Can I renew my lease?';
  assert public.inbox_unread_count()=1;
  perform public.mark_thread_read('/conversation/'||l.lease_id,now());
  assert public.inbox_unread_count()=0;
  perform public.send_lease_message(l.lease_id,l.resident_id,'72400000-0000-4000-8000-000000000002','Yes, I will send renewal terms.');
end $$;
select pg_temp.actor('72000000-0000-4000-8000-000000000004');
do $$ begin
  assert not exists(select from public.inbox_leases());
  assert not exists(select from public.lease_thread('72300000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000002'));
  assert public.inbox_unread_count()=0;
  assert not has_function_privilege('authenticated','public.inbox_delivery(uuid)','EXECUTE');
end $$;
select pg_temp.actor('72000000-0000-4000-8000-000000000002');
do $$ begin
  assert public.inbox_unread_count()=1;
  assert (select body='Yes, I will send renewal terms.' from public.inbox_activity());
  perform public.mark_inbox_read((select id from public.inbox_activity()));
  assert public.inbox_unread_count()=0;
end $$;
-- A reply on a repair is visible independently from its status in the job list.
insert into public.maintenance_requests(id,owner_id,lease_id,unit_id,property_id,tenant_user_id,title)
  values('72500000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001',
    '72300000-0000-4000-8000-000000000001','72200000-0000-4000-8000-000000000001',
    '72100000-0000-4000-8000-000000000001',auth.uid(),'Kitchen sink');
insert into public.request_messages(request_id,sender_id,body)
  values('72500000-0000-4000-8000-000000000001',auth.uid(),'It is still leaking.');
select pg_temp.actor('72000000-0000-4000-8000-000000000003');
do $$ begin
  assert exists(select from public.unread_repair_replies() where request_id='72500000-0000-4000-8000-000000000001');
  perform public.mark_thread_read('/request/72500000-0000-4000-8000-000000000001',now());
  assert not exists(select from public.unread_repair_replies());
end $$;
reset role;
-- Owner archives using the same RPC as the lease screen.
set local role authenticated;
select pg_temp.actor('72000000-0000-4000-8000-000000000001');
select set_config('test.inbox_thread',(select thread_id::text from public.inbox_leases()),true);
select public.revoke_lease_portal('72300000-0000-4000-8000-000000000001',true);
do $$
declare l record;
begin
 select * into strict l from public.inbox_leases();
 assert not l.can_post and l.thread_id=current_setting('test.inbox_thread')::uuid;
 assert (select count(*)=2 from public.lease_thread(l.lease_id,l.resident_id,l.thread_id));
 begin
   perform public.send_lease_message(l.lease_id,l.resident_id,gen_random_uuid(),'Attempt on archive');
   raise exception 'unexpected historical send';
 exception when insufficient_privilege then null; end;
end $$;
select pg_temp.actor('72000000-0000-4000-8000-000000000003');
do $$ begin
 assert (select not can_post and resident_id='72000000-0000-4000-8000-000000000002' from public.inbox_leases());
 assert (select count(*)=2 from public.lease_thread('72300000-0000-4000-8000-000000000001',null,current_setting('test.inbox_thread')::uuid));
end $$;
set local role authenticated;
select pg_temp.actor('72000000-0000-4000-8000-000000000002');
do $$ begin
  assert not exists(select from public.inbox_activity());
  assert not exists(select from public.inbox_leases());
  assert not exists(select from public.lease_thread('72300000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000002'));
end $$;
reset role;
do $$ begin
  assert not exists(select from public.inbox_events e cross join lateral public.inbox_delivery(e.id) d
    where e.recipient_id='72000000-0000-4000-8000-000000000002');
end $$;
-- Auth erasure clears personally identifying references without destroying the thread.
select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true);
delete from auth.users where id='72000000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.actor('72000000-0000-4000-8000-000000000001');
do $$ declare l record; begin
 select * into strict l from public.inbox_leases(null,current_setting('test.inbox_thread')::uuid);
 assert not l.can_post and l.resident_id is null and l.contact_name='Former resident';
 assert (select count(*)=2 from public.lease_thread(l.lease_id,null,l.thread_id));
 assert exists(select from public.lease_thread(l.lease_id,null,l.thread_id) where sender_name='Former resident' and body='Can I renew my lease?');
end $$;
select pg_temp.actor('72000000-0000-4000-8000-000000000004');
do $$ begin
 assert not exists(select from public.lease_thread('72300000-0000-4000-8000-000000000001',null,current_setting('test.inbox_thread')::uuid));
end $$;
reset role;
-- Place equal-time entries above the existing events. Entirely inaccessible pages
-- still have a cursor. A newly arrived entry must not shift the second page.
insert into public.inbox_events(id,recipient_id,property_id,title,body,href,created_at)
select ('72800000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'72000000-0000-4000-8000-000000000001',
 '72100000-0000-4000-8000-000000000001','Event '||n,'Fixture',
 case when n>=103 then '/contractor/job/72900000-0000-4000-8000-000000000099' else '/inbox' end,now()+interval '1 second'
from generate_series(1,104) n;
set local role authenticated;
select pg_temp.actor('72000000-0000-4000-8000-000000000001');
do $$ declare page jsonb; begin
 page:=public.inbox_activity(null,null,2);
 assert jsonb_array_length(page->'events')=0 and page->'next'->>'id'='72800000-0000-4000-8000-000000000103';
 perform set_config('test.inbox_cursor',(page->'next')::text,true);
 assert public.inbox_unread_count()=99;
end $$;
reset role;
insert into public.inbox_events(recipient_id,property_id,title,body,href,created_at) values
 ('72000000-0000-4000-8000-000000000001','72100000-0000-4000-8000-000000000001','New arrival','Fixture','/inbox',now()+interval '2 seconds');
set local role authenticated;
do $$ declare cursor_info jsonb:=current_setting('test.inbox_cursor')::jsonb; page jsonb; begin
 page:=public.inbox_activity((cursor_info->>'at')::timestamptz,(cursor_info->>'id')::uuid,2);
 assert page->'events'->0->>'title'='Event 102' and page->'events'->1->>'title'='Event 101';
 assert page->'next'->>'id'='72800000-0000-4000-8000-000000000101';
 page:=public.inbox_activity(null,null,10000);
 assert jsonb_array_length(page->'events')<=100 and page->'next'<>'null'::jsonb;
end $$;
reset role;
update public.inbox_events set read_at=now()-interval '91 days' where title='Event 90';
update public.inbox_events set read_at=now()-interval '89 days' where title='Event 89';
do $$ begin
 assert rentview_private.prune_read_inbox_events()=1;
 assert not exists(select from public.inbox_events where title='Event 90');
 assert exists(select from public.inbox_events where title='Event 89');
 assert exists(select from public.inbox_events where title='Event 88' and read_at is null);
 assert (select count(*)=2 from public.lease_messages where conversation_id=current_setting('test.inbox_thread')::uuid);
end $$;
rollback;
