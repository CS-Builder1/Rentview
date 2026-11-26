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
-- Pre-migration documents may share one object across different locations.
insert into public.documents(owner_id,property_id,name,storage_path)
values ('dddd0000-0000-4000-8000-000000000001',null,'Legacy unassigned','legacy/shared.pdf');
insert into storage.objects(bucket_id,name,owner,owner_id)
values ('attachments','legacy/shared.pdf','dddd0000-0000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.actor('dddd0000-0000-4000-8000-000000000001');
insert into public.properties(id,owner_id,name) values('dddd0000-1000-4000-8000-000000000001',auth.uid(),'Harbour House');
reset role;
select set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claims','{}',true);
insert into public.documents(owner_id,property_id,name,storage_path) values
 ('dddd0000-0000-4000-8000-000000000001','dddd0000-1000-4000-8000-000000000001','Legacy property copy','legacy/shared.pdf');
set local role authenticated;
select pg_temp.actor('dddd0000-0000-4000-8000-000000000001');
select public.invite_property_manager('dddd0000-1000-4000-8000-000000000001','manager@handover.test');
select public.invite_property_manager('dddd0000-1000-4000-8000-000000000001','next@handover.test');
select public.invite_property_manager('dddd0000-1000-4000-8000-000000000001','resident@handover.test');
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
-- Ordinary delegated bookkeeping preserves the complete lease history.
with removed as (delete from public.units where id='dddd0000-2000-4000-8000-000000000001' returning id)
select pg_temp.ok(count(*)=0,'Only the owner can delete a unit') from removed;
with removed as (delete from public.rent_payments where amount=700 returning id)
select pg_temp.ok(count(*)=0,'Only the owner can delete a payment') from removed;
update public.leases set start_date=current_date+7 where id='dddd0000-3000-4000-8000-000000000001';
select set_config('test.handover_invite',(public.create_tenant_invite('dddd0000-3000-4000-8000-000000000001',null)).code,true);
insert into storage.objects(bucket_id,name,owner,owner_id) values('attachments',auth.uid()::text||'/documents/report.pdf',auth.uid(),auth.uid()::text);
insert into public.documents(owner_id,property_id,name,storage_path) values(auth.uid(),'dddd0000-1000-4000-8000-000000000001','Report',auth.uid()::text||'/documents/report.pdf');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000004');
select public.claim_tenant_invite(current_setting('test.handover_invite'));
do $$ begin
  perform public.accept_manager_invitation('dddd0000-1000-4000-8000-000000000001');
  raise exception 'Only property manager accounts can accept staff invites';
exception when insufficient_privilege then
  perform pg_temp.ok(sqlerrm='Use a property manager account to accept this invitation','Verified resident sees the account-role requirement');
end $$;
select pg_temp.ok(public.claim_tenant_invite(current_setting('test.handover_invite'))->>'lease_id'
  ='dddd0000-3000-4000-8000-000000000001','A future resident can retry a successful claim');
select pg_temp.ok(not exists(select from public.tenant_lease_details) and not exists(select from public.rent_payments),
  'Claiming before move-in does not grant current-occupant access');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000002');
update public.leases set start_date=current_date,end_date=current_date where id='dddd0000-3000-4000-8000-000000000001';
-- Match the portal's UTC lease boundary even when a request uses a different timezone.
select set_config('TimeZone',case when extract(hour from now() at time zone 'UTC')>=10
  then 'Pacific/Kiritimati' else 'Etc/GMT+12' end,true);
select pg_temp.ok((select public.lease_is_current(l) from public.leases l
 where id='dddd0000-3000-4000-8000-000000000001'),'UTC move-in day is consistent across session timezones');
set local timezone='UTC';
select pg_temp.actor('dddd0000-0000-4000-8000-000000000004');
select pg_temp.ok(exists(select from public.rent_payments where amount=700),'Current resident should see the payment');
insert into public.maintenance_requests(id,owner_id,lease_id,unit_id,property_id,tenant_user_id,title)
 select 'dddd0000-4000-4000-8000-000000000001',owner_id,lease_id,unit_id,property_id,auth.uid(),'Drain repair' from public.tenant_lease_details returning id;
select pg_temp.actor('dddd0000-0000-4000-8000-000000000002');
select public.convert_request_to_work_order('dddd0000-4000-4000-8000-000000000001');
select set_config('test.returned_part',public.add_work_order_part(
  (select work_order_id from public.maintenance_requests where id='dddd0000-4000-4000-8000-000000000001'),
  null,'Unused seal',1,2,'USD')::text,true);
update public.work_orders set status='cancelled' where id=(select work_order_id from public.maintenance_requests
 where id='dddd0000-4000-4000-8000-000000000001');
select public.remove_work_order_part(current_setting('test.returned_part')::uuid);
select pg_temp.ok((select removed_at is not null from public.work_order_parts
 where id=current_setting('test.returned_part')::uuid),'Assigned manager can return an unposted cancelled-job part');
select public.revoke_lease_portal('dddd0000-3000-4000-8000-000000000001',true);
select pg_temp.ok(exists(select from public.leases where archived_at is not null),'Manager retains archived lease');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000004');
select pg_temp.ok(not exists(select from public.rent_payments) and not exists(select from public.maintenance_requests),'Archived tenancy removes resident access');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000003');
select public.accept_manager_invitation('dddd0000-1000-4000-8000-000000000001');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000001');
-- Owners can move a sole binding into or out of a property.
update public.documents set property_id=null where name='Report';
select pg_temp.actor('dddd0000-0000-4000-8000-000000000002');
select pg_temp.ok(not exists(select from storage.objects where name like '%/report.pdf'),'Removing property restricts former manager file access');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000001');
update public.documents set property_id='dddd0000-1000-4000-8000-000000000001' where name='Report';
select public.handover_property_manager('dddd0000-1000-4000-8000-000000000001','dddd0000-0000-4000-8000-000000000002','dddd0000-0000-4000-8000-000000000003');
select public.offer_portfolio_transfer('dddd0000-0000-4000-8000-000000000003');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000002');
select pg_temp.ok(not exists(select from public.properties) and not exists(select from storage.objects where name like '%/report.pdf'),'Outgoing manager no longer has access');
select pg_temp.actor('dddd0000-0000-4000-8000-000000000003');
select public.accept_portfolio_transfer('dddd0000-0000-4000-8000-000000000001');
select pg_temp.ok(exists(select from public.properties where owner_id=auth.uid()) and exists(select from public.rent_payments where owner_id=auth.uid())
 and exists(select from public.maintenance_requests where owner_id=auth.uid()) and exists(select from storage.objects where name like '%/report.pdf'),'Transferred property, history, payments and report belong to successor');
select pg_temp.ok((select count(*)=2 from public.documents where storage_path='legacy/shared.pdf')
  and exists(select from storage.objects where name='legacy/shared.pdf' and owner_id=auth.uid()::text),
  'Legacy document copies and their original object transferred together');
delete from public.documents where name='Legacy property copy';
select pg_temp.ok(exists(select from storage.objects where name='legacy/shared.pdf'),
  'The remaining document still has its shared file');
-- Use the same deletion setting as the Storage service on these synthetic rows.
set local storage.allow_delete_query='true';
with removed as (delete from storage.objects where bucket_id='attachments' and name='legacy/shared.pdf' returning id)
select pg_temp.ok(count(*)=0,'Delete keeps the object while another document references it') from removed;
delete from public.documents where name='Legacy unassigned';
with removed as (delete from storage.objects where bucket_id='attachments' and name='legacy/shared.pdf' returning id)
select pg_temp.ok(count(*)=1,'The owner can remove an unreferenced file') from removed;
reset role;
select pg_temp.ok((select property_id is null and portfolio_owner='dddd0000-0000-4000-8000-000000000003'
 from rentview_private.document_file_scope where path='legacy/shared.pdf'),'Shared legacy path stays owner-only');
set local role authenticated;
select pg_temp.actor('dddd0000-0000-4000-8000-000000000001');
select pg_temp.ok(not exists(select from public.properties) and not exists(select from storage.objects where name like '%/report.pdf'),'Former portfolio owner loses staff access');
rollback;
