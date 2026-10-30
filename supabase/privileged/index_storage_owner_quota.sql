-- Explicit owner maintenance, NOT an automatic migration.
-- Local synthetic verification is authorized; hosted execution needs separate
-- target authorization and the actual Storage owner. Never grant an app role
-- ownership or broaden permissions to make this script run.
-- Adds only the exact native ownership/time quota index. Existing grants,
-- policies, objects, ownership, functions and stored files are unchanged.
begin;
set local search_path='';
do $storage_index_owner$
declare index_exists boolean;
begin
 if current_user<>'supabase_storage_admin' or current_user is distinct from (
  select pg_catalog.pg_get_userbyid(c.relowner) from pg_catalog.pg_class c where c.oid=pg_catalog.to_regclass('storage.objects')) then
  raise exception 'Run only as the actual Storage table owner; no changes were made' using errcode='42501';
 end if;
 if not (exists(select 1 from pg_catalog.pg_attribute where attrelid='storage.objects'::regclass and attname='owner_id' and atttypid='text'::regtype and not attisdropped)
 and exists(select 1 from pg_catalog.pg_attribute where attrelid='storage.objects'::regclass and attname='owner' and atttypid='uuid'::regtype and not attisdropped)
 and exists(select 1 from pg_catalog.pg_attribute where attrelid='storage.objects'::regclass and attname='created_at' and atttypid='timestamptz'::regtype and not attisdropped)) then
  raise exception 'Storage owner layout changed; review quota index maintenance' using errcode='55000';
 end if;
 index_exists:=pg_catalog.to_regclass('storage.rentview_storage_owner_created_idx') is not null;
 if index_exists and not (exists(
 select 1 from pg_catalog.pg_index i
 join pg_catalog.pg_class c on c.oid=i.indexrelid
 join pg_catalog.pg_class t on t.oid=i.indrelid
 join pg_catalog.pg_am a on a.oid=c.relam
 join pg_catalog.pg_attribute d on d.attrelid=t.oid and d.attname='created_at' and not d.attisdropped
 join pg_catalog.pg_attribute u on u.attrelid=t.oid and u.attname='owner_id' and not u.attisdropped
 where c.oid=pg_catalog.to_regclass('storage.rentview_storage_owner_created_idx')
  and i.indrelid='storage.objects'::regclass and c.relkind='i' and c.relowner=t.relowner
  and a.amname='btree' and i.indisvalid and i.indisready and i.indislive
  and not i.indisunique and not i.indisexclusion and i.indnkeyatts=2 and i.indnatts=2
  and i.indkey[0]=0 and i.indkey[1]=d.attnum and i.indpred is null
  and i.indoption[0]=0 and i.indoption[1]=3
  and i.indcollation[0]=u.attcollation and i.indcollation[1]=0
  and i.indclass[0]=(select oid from pg_catalog.pg_opclass where opcnamespace='pg_catalog'::regnamespace and opcname='text_ops' and opcmethod=c.relam)
  and i.indclass[1]=(select oid from pg_catalog.pg_opclass where opcnamespace='pg_catalog'::regnamespace and opcname='timestamptz_ops' and opcmethod=c.relam)
  and pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.pg_get_expr(i.indexprs,i.indrelid)),'[[:space:]()]','','g')
   =$expression$coalescenullifowner_id,''::text,owner::text$expression$
)) then
  raise exception 'Existing Storage quota index does not match the reviewed definition' using errcode='55000';
 end if;
 if not index_exists then
  create index rentview_storage_owner_created_idx on storage.objects
   ((coalesce(nullif(owner_id,''),owner::text)),created_at desc);
 end if;
 if not (exists(
 select 1 from pg_catalog.pg_index i
 join pg_catalog.pg_class c on c.oid=i.indexrelid
 join pg_catalog.pg_class t on t.oid=i.indrelid
 join pg_catalog.pg_am a on a.oid=c.relam
 join pg_catalog.pg_attribute d on d.attrelid=t.oid and d.attname='created_at' and not d.attisdropped
 join pg_catalog.pg_attribute u on u.attrelid=t.oid and u.attname='owner_id' and not u.attisdropped
 where c.oid=pg_catalog.to_regclass('storage.rentview_storage_owner_created_idx')
  and i.indrelid='storage.objects'::regclass and c.relkind='i' and c.relowner=t.relowner
  and a.amname='btree' and i.indisvalid and i.indisready and i.indislive
  and not i.indisunique and not i.indisexclusion and i.indnkeyatts=2 and i.indnatts=2
  and i.indkey[0]=0 and i.indkey[1]=d.attnum and i.indpred is null
  and i.indoption[0]=0 and i.indoption[1]=3
  and i.indcollation[0]=u.attcollation and i.indcollation[1]=0
  and i.indclass[0]=(select oid from pg_catalog.pg_opclass where opcnamespace='pg_catalog'::regnamespace and opcname='text_ops' and opcmethod=c.relam)
  and i.indclass[1]=(select oid from pg_catalog.pg_opclass where opcnamespace='pg_catalog'::regnamespace and opcname='timestamptz_ops' and opcmethod=c.relam)
  and pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.pg_get_expr(i.indexprs,i.indrelid)),'[[:space:]()]','','g')
   =$expression$coalescenullifowner_id,''::text,owner::text$expression$
)) then
  raise exception 'Storage quota index postcondition failed' using errcode='55000';
 end if;
end $storage_index_owner$;
commit;
