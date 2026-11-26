-- Run on the previous release with psql -f before applying the correction.
-- Rehearse the actual upgrade and roll both the migration and fixtures back.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at)
values ('03000000-0000-4000-8000-000000000001','invite-upgrade-owner@example.test','{}',now());
insert into public.properties(id,owner_id,name)
values ('03000000-0000-4000-8000-000000000002','03000000-0000-4000-8000-000000000001','Invite upgrade fixture');
insert into public.units(id,owner_id,property_id,label)
values ('03000000-0000-4000-8000-000000000003','03000000-0000-4000-8000-000000000001','03000000-0000-4000-8000-000000000002','Fixture unit');
insert into public.leases(id,owner_id,unit_id,tenant_name,status)
values ('03000000-0000-4000-8000-000000000004','03000000-0000-4000-8000-000000000001','03000000-0000-4000-8000-000000000003','Fixture resident','active');
insert into public.tenant_invites(owner_id,lease_id,code,expires_at,claimed_at)
select '03000000-0000-4000-8000-000000000001','03000000-0000-4000-8000-000000000004',code,expiry,claimed
from (values
  ('OLD123', now() + interval '1 day', null::timestamptz),
  ('OLD456', now() - interval '1 day', null),
  ('OLD789', now() + interval '1 day', now() - interval '1 day'),
  ('0123456789ABCDEFFEDCBA9876543210', now() + interval '1 day', null)
) fixtures(code,expiry,claimed);

\ir ../../supabase/migrations/20261126000320_limit_tenant_invite_claims.sql

do $$ begin
  if (select count(*) = 4 and bool_and(case code
      when 'OLD123' then expires_at = now()
      when 'OLD456' then expires_at = now() - interval '1 day'
      when 'OLD789' then expires_at = now() + interval '1 day' and claimed_at = now() - interval '1 day'
      when '0123456789ABCDEFFEDCBA9876543210' then expires_at = now() + interval '1 day'
      else false end)
    from public.tenant_invites where lease_id = '03000000-0000-4000-8000-000000000004') is distinct from true then
    raise exception 'Unexpected legacy, claimed or secure invitation after upgrade';
  end if;
end $$;
rollback;
