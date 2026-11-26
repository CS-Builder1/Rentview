-- Disposable local database only. Prove direct API-style casts and RPC inputs
-- reject PostgreSQL special numerics, preserving every finite fixture value.
begin;
create function pg_temp.expect_error(statement text,expected_state text,expected_message text default null) returns void language plpgsql as $$
begin
 begin execute statement;
 exception when others then
  if sqlstate=expected_state and (expected_message is null or sqlerrm=expected_message) then return; end if;
  raise exception 'Expected SQLSTATE % / %, got %: %',expected_state,expected_message,sqlstate,sqlerrm;
 end;
 raise exception 'Expected SQLSTATE %, but statement succeeded',expected_state;
end $$;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values('b1000000-0000-4000-8000-000000000001','numeric-fixture@example.test',now(),'{}');
insert into public.properties(id,owner_id,name,estimated_value) values('b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','Finite numeric building',100);
insert into public.units(id,owner_id,property_id,label,bathrooms,size_value,rent_amount) values('b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','Finite unit',1,100,100);
insert into public.leases(id,owner_id,unit_id,tenant_name,rent_amount,deposit_amount) values('b4000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','Synthetic numeric tenant',100,100);
insert into public.assets(id,owner_id,property_id,name,purchase_cost) values('b5000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','Finite asset',100);
insert into public.inventory_items(id,owner_id,property_id,name,quantity,unit_cost,low_stock_threshold,cost_currency) values('b6000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','Finite stock',5,2,1,'USD');
insert into public.work_orders(id,owner_id,property_id,title,cost) values('b7000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','Finite job',0);
insert into public.expenses(id,owner_id,property_id,amount,currency) values('b8000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001',1,'USD');
insert into public.rent_payments(id,owner_id,lease_id,amount,currency) values('b9000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001',100,'USD');
select set_config('request.jwt.claim.sub','b1000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"role":"authenticated","sub":"b1000000-0000-4000-8000-000000000001"}',true);
set local role authenticated;
do $$ declare target record; special text; expected_state text; begin
 for target in select * from (values
  ('properties','estimated_value','b2000000-0000-4000-8000-000000000001'),
  ('units','bathrooms','b3000000-0000-4000-8000-000000000001'),
  ('units','size_value','b3000000-0000-4000-8000-000000000001'),
  ('units','rent_amount','b3000000-0000-4000-8000-000000000001'),
  ('leases','rent_amount','b4000000-0000-4000-8000-000000000001'),
  ('leases','deposit_amount','b4000000-0000-4000-8000-000000000001'),
  ('assets','purchase_cost','b5000000-0000-4000-8000-000000000001'),
  ('inventory_items','quantity','b6000000-0000-4000-8000-000000000001'),
  ('inventory_items','unit_cost','b6000000-0000-4000-8000-000000000001'),
  ('inventory_items','low_stock_threshold','b6000000-0000-4000-8000-000000000001'),
  ('work_orders','cost','b7000000-0000-4000-8000-000000000001'),
  ('expenses','amount','b8000000-0000-4000-8000-000000000001'),
  ('rent_payments','amount','b9000000-0000-4000-8000-000000000001')
 ) v(table_name,column_name,row_id) loop
  foreach special in array array['NaN','Infinity','-Infinity'] loop
   expected_state:=case when special='NaN' then '23514' else '22003' end;
   perform pg_temp.expect_error(format('update public.%I set %I=%L::numeric where id=%L',target.table_name,target.column_name,special,target.row_id),expected_state);
  end loop;
 end loop;
 foreach special in array array['NaN','Infinity','-Infinity'] loop
  perform pg_temp.expect_error(format('select public.add_work_order_part(''b7000000-0000-4000-8000-000000000001'',''b6000000-0000-4000-8000-000000000001'',null,%L::numeric,null,''USD'',null)',special),'23514','Quantity must be finite and positive');
  perform pg_temp.expect_error(format('select public.add_work_order_part(''b7000000-0000-4000-8000-000000000001'',''b6000000-0000-4000-8000-000000000001'',null,1,%L::numeric,''USD'',null)',special),'23514','Cost must be finite and zero or positive');
  perform pg_temp.expect_error(format('select public.complete_work_order(''b7000000-0000-4000-8000-000000000001'',%L::numeric,''USD'',null,false)',special),'23514','Labor cost must be finite and zero or positive');
 end loop;
 assert (select quantity=5 and unit_cost=2 and low_stock_threshold=1 from public.inventory_items where id='b6000000-0000-4000-8000-000000000001'),'rejected special values changed stock';
 assert (select cost=0 and status='open' and completion_expense_id is null from public.work_orders where id='b7000000-0000-4000-8000-000000000001'),'rejected special values posted a completion';
 assert (select count(*)=0 from public.work_order_parts),'rejected special values created parts';
 assert (select count(*)=1 and sum(amount)=1 from public.expenses),'rejected special values changed the expense ledger';
end $$;
rollback;
