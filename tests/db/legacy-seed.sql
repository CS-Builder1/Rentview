-- Disposable local database only, AFTER 0001..0009 and BEFORE the pending SQL.
-- These deliberately inconsistent records emulate writes allowed by the old
-- ownership model. legacy-check.sql verifies migration preservation and removes
-- only these synthetic identities before validating the new constraints.
begin;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('90000000-0000-4000-8000-000000000001','legacy-owner-a@example.test',now(),'{}'),
 ('90000000-0000-4000-8000-000000000002','legacy-owner-b@example.test',now(),'{}'),
 ('90000000-0000-4000-8000-000000000003','legacy-tenant@example.test',now(),'{}');
insert into public.properties(id,owner_id,name) values
 ('91000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001','Synthetic legacy A'),
 ('91000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000002','Synthetic legacy B');
insert into public.units(id,owner_id,property_id,label) values
 ('92000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000002','Inconsistent legacy unit'),
 ('92000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-000000000002','Legitimate B unit');
insert into public.leases(id,owner_id,unit_id,tenant_name,tenant_user_id,status) values
 ('93000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000002','Synthetic legacy tenant','90000000-0000-4000-8000-000000000003','active');
insert into public.maintenance_requests(id,owner_id,property_id,unit_id,lease_id,tenant_user_id,title) values
 ('94000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000002','92000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000003','Inconsistent legacy request');
insert into public.request_messages(request_id,sender_id,body) values
 ('94000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000003','Synthetic legacy message');
insert into public.tenant_invites(id,owner_id,lease_id,code) values
 ('95000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001','LEGACYSYNTHETICINVALIDINVITATION');
insert into public.expenses(id,owner_id,property_id,category,description,amount,currency,incurred_on) values
 ('96000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000002','repair','Inconsistent legacy invoice',1,'USD',current_date);
insert into public.subscriptions(owner_id,provider,provider_subscription_id,plan,status) values
 ('90000000-0000-4000-8000-000000000001','paypal','synthetic-unverified-legacy-subscription','pro','active');
commit;
