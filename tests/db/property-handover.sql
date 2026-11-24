-- Roll back synthetic identities and a property's complete tenancy history.
begin;
create function pg_temp.actor(uid uuid) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',uid::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated')::text,true);
end $$;
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception '%',label; end if; end $$;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values
('dddd0000-0000-4000-8000-000000000001','owner@handover.test','{}',now()),
('dddd0000-0000-4000-8000-000000000002','manager@handover.test','{}',now()),
('dddd0000-0000-4000-8000-000000000003','next@handover.test','{}',now()),
('dddd0000-0000-4000-8000-000000000004','resident@handover.test','{}',now());
set local role authenticated;
select pg_temp.actor('dddd0000-0000-4000-8000-000000000001');
insert into public.properties(id,owner_id,name) values('dddd0000-1000-4000-8000-000000000001',auth.uid(),'Harbour House');
select public.invite_property_manager('dddd0000-1000-4000-8000-000000000001','manager@handover.test');
select public.invite_property_manager('dddd0000-1000-4000-8000-000000000001','next@handover.test');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000002');
select pg_temp.ok(exists(select from public.my_manager_invitations() where property_name='Harbour House'),'Verified manager should see their invitation');
select public.accept_manager_invitation('dddd0000-1000-4000-8000-000000000001');
insert into public.units (id,owner_id,property_id,label) values
 ('dddd0000-2000-4000-8000-000000000001',auth.uid(),'dddd0000-1000-4000-8000-000000000001','Garden');
insert into public.leases(id,owner_id,unit_id,tenant_name,tenant_email) values
 ('dddd0000-3000-4000-8000-000000000001',auth.uid(),'dddd0000-2000-4000-8000-000000000001','Resident','resident@handover.test') returning id;
insert into public.rent_payments(owner_id,lease_id,amount) values
 (auth.uid(),'dddd0000-3000-4000-8000-000000000001',700);
select pg_temp.ok((select created_by=auth.uid() and owner_id<>auth.uid() from public.rent_payments where amount=700),'Offline intent author and portfolio owner should persist separately');
select set_config('test.handover_invite',(public.create_tenant_invite('dddd0000-3000-4000-8000-000000000001',null)).code,true);
insert into storage.objects(bucket_id,name,owner,owner_id) values('attachments',auth.uid()::text||'/documents/report.pdf',auth.uid(),auth.uid()::text);
insert into public.documents(owner_id,property_id,name,storage_path) values(auth.uid(),'dddd0000-1000-4000-8000-000000000001','Report',auth.uid()::text||'/documents/report.pdf');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000004');
select public.claim_tenant_invite(current_setting('test.handover_invite'));
select pg_temp.ok(exists(select from public.rent_payments where amount=700),'Current resident should see the payment');
insert into public.maintenance_requests(id,owner_id,lease_id,unit_id,property_id,tenant_user_id,title)
 select 'dddd0000-4000-4000-8000-000000000001',owner_id,lease_id,unit_id,property_id,auth.uid(),'Drain repair' from public.tenant_lease_details returning id;
select pg_temp.actor('dddd0000-0000-4000-8000-000000000002');
select public.convert_request_to_work_order('dddd0000-4000-4000-8000-000000000001');
select public.revoke_lease_portal('dddd0000-3000-4000-8000-000000000001',true);
select pg_temp.ok(exists(select from public.leases where archived_at is not null),'Manager retains archived lease');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000004');
select pg_temp.ok(not exists(select from public.rent_payments) and not exists(select from public.maintenance_requests),'Archived tenancy removes resident access');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000003');
select public.accept_manager_invitation('dddd0000-1000-4000-8000-000000000001');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000001');
select public.handover_property_manager('dddd0000-1000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000002','dddd0000-0000-4000-8000-000000000003');
select public.offer_portfolio_transfer('dddd0000-0000-4000-8000-000000000003');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000002');
select pg_temp.ok(not exists(select from public.properties) and not exists(select from storage.objects where name like '%/report.pdf'),'Outgoing manager no longer has access');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000003');
select public.accept_portfolio_transfer('dddd0000-0000-4000-8000-000000000001');
select pg_temp.ok(exists(select from public.properties where owner_id=auth.uid()) and exists(select from public.rent_payments where owner_id=auth.uid())
 and exists(select from public.maintenance_requests where owner_id=auth.uid()) and exists(select from storage.objects where name like '%/report.pdf'),'Transferred property, history, payments and report belong to successor');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000001');
select pg_temp.ok(not exists(select from public.properties) and not exists(select from storage.objects where name like '%/report.pdf'),'Former portfolio owner loses staff access');
rollback;
