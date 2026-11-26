-- Explicit privileged maintenance; NOT an automatic migration.
-- Validated target layout: pg_net0.20.4, functions and queue in net.
-- Run only on an explicitly authorized target, as the actual extension owner.
-- A postgres-issued REVOKE cannot remove supabase_admin-issued grants.
-- This script does not acquire privileges, relocate/reinstall the extension,
-- alter queues/triggers/functions, or suppress the public-namespace warning.
-- Hosted execution requires separate approval and authorized platform support.
-- Keep net out of PostgREST exposed schemas; recheck ACLs after extension or
-- platform bootstrap updates that may restore default grants.

begin;
set local search_path='';

do $$
declare extension_row record; net_oid oid; role_name text;
begin
  select e.oid,e.extowner,e.extversion,e.extrelocatable into extension_row
    from pg_catalog.pg_extension e where e.extname='pg_net';
  if not found then raise exception 'pg_net is not installed'; end if;
  if current_user<>pg_catalog.pg_get_userbyid(extension_row.extowner) then
    raise exception 'Run only as the actual pg_net owner/grantor; no privileges were changed'
      using errcode='42501';
  end if;
  if extension_row.extversion<>'0.20.4' or extension_row.extrelocatable then
    raise exception 'Unexpected pg_net version/layout; review before privileged maintenance';
  end if;
  select n.oid into net_oid from pg_catalog.pg_namespace n
    where n.nspname='net' and n.nspowner=extension_row.extowner;
  if not found then raise exception 'Expected owner-controlled net schema is absent'; end if;
  if not exists(select 1 from pg_catalog.pg_depend d
    where d.classid='pg_catalog.pg_namespace'::regclass and d.objid=net_oid
      and d.refclassid='pg_catalog.pg_extension'::regclass
      and d.refobjid=extension_row.oid and d.deptype='e') then
    raise exception 'net is not a member of the expected extension';
  end if;
  -- Refuse an unexpected mixed-owner/custom-function schema rather than alter
  -- unrelated objects under a broad ALL FUNCTIONS privilege statement.
  if exists(select 1 from pg_catalog.pg_proc p where p.pronamespace=net_oid
    and (p.proowner<>extension_row.extowner or not exists(
      select 1 from pg_catalog.pg_depend d
      where d.classid='pg_catalog.pg_proc'::regclass and d.objid=p.oid
        and d.refclassid='pg_catalog.pg_extension'::regclass
        and d.refobjid=extension_row.oid and d.deptype='e'))) then
    raise exception 'Unexpected functions or owners in net; review required';
  end if;
  if exists(select 1 from pg_catalog.pg_depend d
    join pg_catalog.pg_proc p on p.oid=d.objid
    where d.classid='pg_catalog.pg_proc'::regclass
      and d.refclassid='pg_catalog.pg_extension'::regclass
      and d.refobjid=extension_row.oid and d.deptype='e'
      and p.pronamespace<>net_oid) then
    raise exception 'Unexpected pg_net function namespace; review required';
  end if;
  foreach role_name in array array['anon','authenticated','postgres','service_role'] loop
    if not exists(select 1 from pg_catalog.pg_roles where rolname=role_name) then
      raise exception 'Expected role missing: %',role_name;
    end if;
  end loop;
end $$;

-- These owner/grantor-issued revocations remove both explicit browser grants
-- and default PUBLIC execution. Other explicit platform-role grants survive.
revoke usage on schema net from public,anon,authenticated;
revoke execute on all functions in schema net from public,anon,authenticated;
grant usage on schema net to postgres,service_role;
grant execute on all functions in schema net to postgres,service_role;

do $$
declare role_name text; function_row record;
begin
  foreach role_name in array array['anon','authenticated'] loop
    if pg_catalog.has_schema_privilege(role_name,'net','usage')
      or pg_catalog.has_schema_privilege(role_name,'net','create') then
      raise exception 'Browser role retains net schema privileges: %',role_name;
    end if;
    for function_row in select p.oid from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='net' loop
      if pg_catalog.has_function_privilege(role_name,function_row.oid,'execute') then
        raise exception 'Browser role retains net function execution: %',role_name;
      end if;
    end loop;
  end loop;
  foreach role_name in array array['postgres','service_role'] loop
    if not pg_catalog.has_schema_privilege(role_name,'net','usage') then
      raise exception 'Trusted worker lost net schema usage: %',role_name;
    end if;
    for function_row in select p.oid from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='net' loop
      if not pg_catalog.has_function_privilege(role_name,function_row.oid,'execute') then
        raise exception 'Trusted worker lacks net function execution: %',role_name;
      end if;
    end loop;
  end loop;
end $$;

commit;
