-- Read-only boundary assertions for the explicitly disposable local project.
-- A failed assertion is a security finding; do not weaken it to pass. The
-- separate API profile test does not establish these SQL privileges are safe.
begin;
set local search_path='';
set local plpgsql.check_asserts=on;

do $$
declare extension_oid oid; role_name text; function_row record;
begin
  select e.oid into extension_oid from pg_catalog.pg_extension e where e.extname='pg_net';
  assert found,'pg_net absent: expected installed extension boundary not tested';
  assert not exists(select 1 from pg_catalog.pg_depend d
    join pg_catalog.pg_proc p on p.oid=d.objid
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where d.classid='pg_catalog.pg_proc'::regclass
      and d.refclassid='pg_catalog.pg_extension'::regclass
      and d.refobjid=extension_oid and d.deptype='e' and n.nspname='public'),
    'pg_net member function unexpectedly exposed in public';
  assert pg_catalog.to_regprocedure('net.http_get(text,jsonb,jsonb,integer)') is not null,
    'Expected worker HTTP GET function missing';
  assert pg_catalog.to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null,
    'Expected worker HTTP POST function missing';
  assert pg_catalog.to_regclass('net.http_request_queue') is not null,
    'Expected worker queue missing';
  foreach role_name in array array['anon','authenticated'] loop
    assert not pg_catalog.has_schema_privilege(role_name,'net','usage'),
      'Browser role can access net schema';
    assert not pg_catalog.has_schema_privilege(role_name,'net','create'),
      'Browser role can create objects in net schema';
    for function_row in select p.oid from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='net' loop
      assert not pg_catalog.has_function_privilege(role_name,function_row.oid,'execute'),
        'Browser role can execute a net function';
    end loop;
    assert not pg_catalog.has_function_privilege(role_name,'public.dispatch_due_notifications()','execute');
    assert not pg_catalog.has_function_privilege(role_name,'public.dispatch_due_reminders()','execute');
    assert not pg_catalog.has_function_privilege(role_name,'public.push_hook_config()','execute');
  end loop;
  foreach role_name in array array['postgres','service_role'] loop
    assert pg_catalog.has_schema_privilege(role_name,'net','usage'),
      'Trusted worker lacks net schema usage';
    for function_row in select p.oid from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='net' loop
      assert pg_catalog.has_function_privilege(role_name,function_row.oid,'execute'),
        'Trusted worker cannot execute a net function';
    end loop;
  end loop;
end $$;

rollback;
