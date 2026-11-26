-- Disposable rollback fixture. Run before and after review corrections.
-- Tests the asserted NO ACTION/cascade interaction instead of assuming a bug.
begin;
set local statement_timeout='10s';
create function pg_temp.ok(value boolean,message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'Assertion failed: %',message; end if; end $$;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('e1000000-0000-4000-8000-000000000001','delete-relations@example.test',now(),'{}');
insert into public.properties(id,owner_id,name) values
 ('e2000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','Delete fixture');
insert into public.units(id,owner_id,property_id,label) values
 ('e3000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','Delete fixture');
insert into public.vendors(id,owner_id,name) values
 ('e4000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','Delete fixture');
insert into public.assets(id,owner_id,property_id,unit_id,name) values
 ('e5000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','Delete fixture');
insert into public.work_orders(id,owner_id,property_id,unit_id,asset_id,vendor_id,title) values
 ('e6000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','e5000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000001','Delete fixture');
insert into public.expenses(owner_id,property_id,unit_id,work_order_id,vendor_id,amount,currency) values
 ('e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','e6000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000001',1,'USD');
insert into public.maintenance_schedules(owner_id,property_id,unit_id,asset_id,title) values
 ('e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','e5000000-0000-4000-8000-000000000001','Delete fixture');
insert into public.documents(owner_id,property_id,unit_id,asset_id,work_order_id,name,storage_path) values
 ('e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','e5000000-0000-4000-8000-000000000001','e6000000-0000-4000-8000-000000000001','Delete fixture','e1000000-0000-4000-8000-000000000001/documents/fixture.pdf');
insert into public.inventory_items(owner_id,property_id,unit_id,name) values
 ('e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','Delete fixture');
insert into public.tasks(owner_id,property_id,unit_id,title) values
 ('e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','Delete fixture');
insert into public.leases(id,owner_id,unit_id,tenant_name) values
 ('e7000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','Delete fixture');
insert into public.maintenance_requests(id,owner_id,property_id,unit_id,lease_id,work_order_id,title) values
 ('e8000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','e7000000-0000-4000-8000-000000000001','e6000000-0000-4000-8000-000000000001','Delete fixture');
insert into public.rent_payments(owner_id,lease_id,amount,currency) values
 ('e1000000-0000-4000-8000-000000000001','e7000000-0000-4000-8000-000000000001',1,'USD');
-- Savepoints retain the same graph for each independently asserted parent.
savepoint each_parent;
delete from public.vendors where id='e4000000-0000-4000-8000-000000000001';
select pg_temp.ok((select vendor_id is null from public.work_orders where id='e6000000-0000-4000-8000-000000000001'),'vendor delete clears linked job');
select pg_temp.ok((select count(*)=1 and bool_and(vendor_id is null) from public.expenses where owner_id='e1000000-0000-4000-8000-000000000001'),'vendor delete clears expense without deleting ledger');
rollback to each_parent;
delete from public.assets where id='e5000000-0000-4000-8000-000000000001';
select pg_temp.ok((select asset_id is null from public.work_orders where id='e6000000-0000-4000-8000-000000000001'),'asset delete clears linked job');
rollback to each_parent;
delete from public.work_orders where id='e6000000-0000-4000-8000-000000000001';
select pg_temp.ok((select work_order_id is null from public.maintenance_requests where id='e8000000-0000-4000-8000-000000000001'),'job delete clears linked request');
rollback to each_parent;
delete from public.units where id='e3000000-0000-4000-8000-000000000001';
select pg_temp.ok((select unit_id is null from public.work_orders where id='e6000000-0000-4000-8000-000000000001'),'unit delete clears shared job scope');
select pg_temp.ok((select count(*)=0 from public.leases where id='e7000000-0000-4000-8000-000000000001'),'unit delete cascades lease');
rollback to each_parent;
delete from public.properties where id='e2000000-0000-4000-8000-000000000001';
select pg_temp.ok((select count(*)=0 from public.work_orders where id='e6000000-0000-4000-8000-000000000001'),'property delete cascades job');
select pg_temp.ok((select count(*)=0 from public.expenses where owner_id='e1000000-0000-4000-8000-000000000001'),'property delete follows existing expense retention policy');
set constraints all immediate;
rollback;
