-- Read-only catalog snapshot for the identity InitPlan optimization.
-- Run only with the approved disposable-local harness; keep output private.
-- Does not read user data, settings values or credential-bearing Vault rows.
select jsonb_build_object(
  'version', 1,
  'policies', (select coalesce(jsonb_agg(to_jsonb(p) order by p.schema,p.table_name,p.name),'[]') from (
    select n.nspname as schema,c.relname as table_name,p.polname as name,
      p.polcmd::text as command,p.polpermissive as permissive,
      array(select case when r=0 then 'PUBLIC' else pg_get_userbyid(r)::text end
        from unnest(p.polroles) r order by 1) as roles,
      pg_get_expr(p.polqual,p.polrelid) as using_expression,
      pg_get_expr(p.polwithcheck,p.polrelid) as check_expression
    from pg_policy p join pg_class c on c.oid=p.polrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','storage','rentview_private','auth','net')
  ) p),
  'relations', (select coalesce(jsonb_agg(to_jsonb(r) order by r.schema,r.name),'[]') from (
    select n.nspname as schema,c.relname as name,c.relkind::text as kind,
      pg_get_userbyid(c.relowner)::text as owner,c.relacl::text as acl,
      c.relrowsecurity as rls,c.relforcerowsecurity as force_rls,c.reloptions as options,
      case when c.relkind in ('v','m') then pg_get_viewdef(c.oid,true) end as view_definition
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','storage','rentview_private','auth','net')
  ) r),
  'columns', (select coalesce(jsonb_agg(to_jsonb(a) order by a.schema,a.table_name,a.position),'[]') from (
    select n.nspname as schema,c.relname as table_name,a.attname as name,a.attnum as position,
      format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as not_null,
      a.attidentity::text as identity,a.attgenerated::text as generated,
      a.attacl::text as acl,pg_get_expr(d.adbin,d.adrelid) as default_expression
    from pg_attribute a join pg_class c on c.oid=a.attrelid
    join pg_namespace n on n.oid=c.relnamespace
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where n.nspname in ('public','storage','rentview_private','auth','net')
      and a.attnum>0 and not a.attisdropped
  ) a),
  'functions', (select coalesce(jsonb_agg(to_jsonb(f) order by f.schema,f.name,f.arguments),'[]') from (
    select n.nspname as schema,p.proname as name,
      pg_get_function_identity_arguments(p.oid) as arguments,
      pg_get_userbyid(p.proowner)::text as owner,p.proacl::text as acl,
      p.prosecdef as security_definer,p.provolatile::text as volatility,
      p.proconfig as config,pg_get_functiondef(p.oid) as definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','storage','rentview_private','auth','net')
      and p.prokind in ('f','p')
  ) f),
  'schemas', (select coalesce(jsonb_agg(to_jsonb(s) order by s.name),'[]') from (
    select n.nspname as name,pg_get_userbyid(n.nspowner)::text as owner,n.nspacl::text as acl
    from pg_namespace n where n.nspname in ('public','storage','rentview_private','auth','net')
  ) s),
  'default_privileges', (select coalesce(jsonb_agg(to_jsonb(d) order by d.owner,d.schema,d.object_type),'[]') from (
    select pg_get_userbyid(d.defaclrole)::text as owner,
      case when d.defaclnamespace=0 then '*global*' else n.nspname end as schema,
      d.defaclobjtype::text as object_type,d.defaclacl::text as acl
    from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
    where d.defaclnamespace=0 or n.nspname in ('public','storage','rentview_private','auth','net')
  ) d),
  'roles', (select coalesce(jsonb_agg(to_jsonb(r) order by r.name),'[]') from (
    select rolname::text as name,rolsuper as superuser,rolinherit as inherit,
      rolcreaterole as create_role,rolcreatedb as create_db,rolcanlogin as login,
      rolreplication as replication,rolbypassrls as bypass_rls
    from pg_roles
  ) r),
  'memberships', (select coalesce(jsonb_agg(to_jsonb(m) order by m.role_name,m.member,m.grantor),'[]') from (
    select pg_get_userbyid(roleid)::text as role_name,pg_get_userbyid(member)::text as member,
      pg_get_userbyid(grantor)::text as grantor,admin_option,inherit_option,set_option
    from pg_auth_members
  ) m),
  'constraints', (select coalesce(jsonb_agg(to_jsonb(k) order by k.schema,k.table_name,k.name),'[]') from (
    select n.nspname as schema,c.relname as table_name,k.conname as name,
      k.contype::text as type,k.convalidated as validated,k.condeferrable as deferrable,
      k.condeferred as deferred,pg_get_constraintdef(k.oid,true) as definition
    from pg_constraint k join pg_class c on c.oid=k.conrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','storage','rentview_private','auth','net')
  ) k),
  'triggers', (select coalesce(jsonb_agg(to_jsonb(t) order by t.schema,t.table_name,t.name),'[]') from (
    select n.nspname as schema,c.relname as table_name,t.tgname as name,
      t.tgenabled::text as enabled,t.tgisinternal as internal,
      pg_get_triggerdef(t.oid,true) as definition
    from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','storage','rentview_private','auth','net')
  ) t),
  'extensions', (select coalesce(jsonb_agg(to_jsonb(e) order by e.name),'[]') from (
    select e.extname as name,e.extversion as version,n.nspname as schema,
      pg_get_userbyid(e.extowner)::text as owner,e.extrelocatable as relocatable
    from pg_extension e join pg_namespace n on n.oid=e.extnamespace
  ) e)
);
