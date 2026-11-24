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
-- Backend revocation removes both the thread and every past delivery preview.
update public.leases set tenant_user_id=null where id='72300000-0000-4000-8000-000000000001';
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
rollback;
