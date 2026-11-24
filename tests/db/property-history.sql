-- Scoped historical fixtures for a disposable local database. No uploaded bytes.
begin;
set local statement_timeout='15s';
create function pg_temp.ok(b boolean, message text) returns void language plpgsql as $$
begin if b is distinct from true then raise exception '%', message; end if; end $$;
create function pg_temp.actor(uid text) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',uid,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated')::text,true);
end $$;

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('d1000000-0000-4000-8000-000000000001','history-owner@example.test',now(),'{}'),
 ('d1000000-0000-4000-8000-000000000002','history-incoming@example.test',now(),'{}'),
 ('d1000000-0000-4000-8000-000000000003','history-manager@example.test',now(),'{}');
insert into public.properties(id,name,owner_id) values
 ('d2000000-0000-4000-8000-000000000001','History building','d1000000-0000-4000-8000-000000000001');
insert into public.units(id,label,owner_id,property_id) values
 ('d3000000-0000-4000-8000-000000000001','2A','d1000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001');
insert into public.assets(id,name,owner_id,property_id,unit_id) values
 ('d4000000-0000-4000-8000-000000000001','AC','d1000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001');
insert into public.leases(id,tenant_name,owner_id,unit_id,status) values
 ('d5000000-0000-4000-8000-000000000001','Previous resident','d1000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001','active');
insert into public.property_managers (property_id,user_id,email) values
 ('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000003','history-manager@example.test');
insert into public.work_orders(id,title,owner_id,property_id,unit_id,asset_id,status,completed_at,cost,cost_currency) values
 ('d6000000-0000-4000-8000-000000000001','AC repair','d1000000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001',
  'completed','2024-01-13 12:00:00+00',450,'USD');

insert into public.dispatch_history(work_order_id,property_id,owner_id,event,detail,created_at) values
 ('d6000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001',
  'field_completed','{"vendor_name":"Taylor HVAC","completion_notes":"Adjusted belt","completion_photos":[]}', '2024-01-12T13:00:00Z'),
 ('d6000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001',
  'field_completed','{"vendor_name":"Taylor HVAC","completion_notes":"Replaced motor","completion_photos":[]}', '2024-01-13T14:00:00Z');
create function pg_temp.record_inspection() returns uuid language sql as $$
 select public.record_property_history('d7000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001',
 'd3000000-0000-4000-8000-000000000001',null,'d5000000-0000-4000-8000-000000000001','inspection','2024-01-31','Move-out walkthrough',
 '','Inspector Lee','move_out','[{"room":"Kitchen","condition":"worn","notes":"Loose hinge","evidence":["history/d2000000-0000-4000-8000-000000000001/d1000000-0000-4000-8000-000000000003/cc000000-0000-4000-8000-000000000001.jpg"]}]','{}',true);
$$;
set local role authenticated;
select pg_temp.actor('d1000000-0000-4000-8000-000000000003');
insert into storage.objects(bucket_id,name,owner_id) values
 ('attachments','history/d2000000-0000-4000-8000-000000000001/d1000000-0000-4000-8000-000000000003/cc000000-0000-4000-8000-000000000001.jpg','d1000000-0000-4000-8000-000000000003');
select pg_temp.ok(exists(select from public.property_event_history where property_id='d2000000-0000-4000-8000-000000000001'
  and unit_id='d3000000-0000-4000-8000-000000000001' and asset_id='d4000000-0000-4000-8000-000000000001'
  and title='AC repair' and kind='work_order' and event_date='2024-01-13' and amount=450 and currency='USD'),
  'Manager should find the dated legacy repair from its property, unit and asset');

select pg_temp.ok((select count(*)=2 from public.property_event_history where kind='dispatch'
  and asset_id='d4000000-0000-4000-8000-000000000001' and details like '%Taylor HVAC%'),
  'Successive work visits should retain their contractor and notes on the asset');
update public.assets set status='needs_attention' where id='d4000000-0000-4000-8000-000000000001';
select pg_temp.ok(exists(select from public.property_event_history where kind='asset_condition'
  and asset_id='d4000000-0000-4000-8000-000000000001' and details like '%needs attention%'),
  'Changing condition on the asset must also add a dated record');
select pg_temp.record_inspection();
select pg_temp.record_inspection();
select pg_temp.ok((select count(*)=1 from public.property_event_history where title='Move-out walkthrough'
  and observer='Inspector Lee' and unresolved and rooms->0->>'room'='Kitchen' and rooms->0->'evidence'->>0='history/d2000000-0000-4000-8000-000000000001/d1000000-0000-4000-8000-000000000003/cc000000-0000-4000-8000-000000000001.jpg'),'Retry duplicated the inspection or room evidence was lost');
select public.resolve_property_history('d7000000-0000-4000-8000-000000000001');
select public.resolve_property_history('d7000000-0000-4000-8000-000000000001');
select pg_temp.ok((select count(*)=1 from public.property_event_history where kind='follow_up'
  and manual_id='d7000000-0000-4000-8000-000000000001'),'Resolution should have one dated event');
select pg_temp.actor('d1000000-0000-4000-8000-000000000001');
select pg_temp.ok(exists(select from storage.objects where name='history/d2000000-0000-4000-8000-000000000001/d1000000-0000-4000-8000-000000000003/cc000000-0000-4000-8000-000000000001.jpg'),'Owner should be able to open manager evidence');
select public.revoke_lease_portal('d5000000-0000-4000-8000-000000000001',true);
select pg_temp.ok(exists(select from public.property_event_history where kind='inspection' and phase='move_out'
  and not unresolved and lease_id='d5000000-0000-4000-8000-000000000001'),'Turnover must preserve the inspection for the owner');
reset role;
insert into public.leases(id,tenant_name,owner_id,unit_id,tenant_user_id,status) values
 ('d5000000-0000-4000-8000-000000000002','Incoming resident','d1000000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002','active');
set local role authenticated;
select pg_temp.actor('d1000000-0000-4000-8000-000000000002');
select pg_temp.ok(not exists(select from public.property_event_history where property_id='d2000000-0000-4000-8000-000000000001'),
  'Incoming tenant must not receive management history');
select pg_temp.ok(not exists(select from storage.objects where name='history/d2000000-0000-4000-8000-000000000001/d1000000-0000-4000-8000-000000000003/cc000000-0000-4000-8000-000000000001.jpg'),'Incoming renter must not receive inspection evidence');
rollback;
