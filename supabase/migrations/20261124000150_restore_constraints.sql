-- The database can restore foreign keys in a different order from their
-- original creation. Mirror the single-ID relationship's deletion action on
-- each composite ownership FK, so every constraint agrees about what a
-- parent deletion means regardless of trigger order.
do $$
declare
  fk record;
  delete_action text;
  definition text;
begin
  for fk in
    select c.conrelid::regclass as relation, c.conname, c.convalidated,
           pg_get_constraintdef(c.oid) as definition, a.attname as link_column,
           parent_link.confdeltype as delete_type
    from pg_constraint c
    join pg_constraint parent_link on parent_link.contype='f'
      and parent_link.conrelid=c.conrelid and parent_link.confrelid=c.confrelid
      and parent_link.conkey=array[c.conkey[1]] and parent_link.confkey=array[c.confkey[1]]
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
    where c.connamespace='public'::regnamespace and c.contype='f'
      and cardinality(c.conkey)>1 and c.confdeltype='a' and parent_link.confdeltype in ('n','c')
      and exists(select from pg_attribute owner_column where owner_column.attrelid=c.conrelid
        and owner_column.attnum=any(c.conkey) and owner_column.attname='owner_id')
  loop
    delete_action := case when fk.delete_type='c' then ' ON DELETE CASCADE'
                          else format(' ON DELETE SET NULL (%I)',fk.link_column) end;
    -- Keep insert/update checks immediate and keep previously unvalidated
    -- legacy constraints unvalidated. Only clear the nullable relationship ID.
    definition := split_part(fk.definition,' DEFERRABLE',1);
    definition := split_part(definition,' NOT VALID',1) || delete_action || ' DEFERRABLE NOT VALID';
    execute format('alter table %s drop constraint %I, add constraint %I %s',
      fk.relation,fk.conname,fk.conname,definition);
    if fk.convalidated then
      execute format('alter table %s validate constraint %I',fk.relation,fk.conname);
    end if;
  end loop;
end $$;

-- Posted jobs and their expense can reference each other. Keep the existing
-- commit-time check on this cyclic relationship when a portfolio is deleted.
alter table public.work_orders alter constraint work_orders_completion_expense_owner_fk deferrable initially deferred;

create or replace function rentview_private.guard_scoped_relations()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  d jsonb := to_jsonb(new);
  previous jsonb;
  parent jsonb;
  col text;
  parent_table text;
begin
  -- Referential actions may clear an author or related ID after the parent
  -- row was already removed by another cascade in this same statement. If
  -- the cascade installs no new non-null scope, the ownership FKs protect it.
  if tg_op='UPDATE' and pg_trigger_depth()>1 and new.owner_id=old.owner_id then
    previous := to_jsonb(old);
    if not exists(select from unnest(array['property_id','unit_id','asset_id','work_order_id']) as scope(col)
      where d->>scope.col is not null and d->>scope.col is distinct from previous->>scope.col) then
      return new;
    end if;
  end if;
  foreach col in array array['unit_id','asset_id','work_order_id'] loop
    if d->>col is null then continue; end if;
    if d ? 'property_id' and d->>'property_id' is null then
      raise exception 'A location is required for the linked record' using errcode='23514';
    end if;
    parent_table := case col when 'unit_id' then 'units' when 'asset_id' then 'assets' else 'work_orders' end;
    execute format('select to_jsonb(p) from public.%I p where id=$1 and owner_id=$2',parent_table)
      into parent using (d->>col)::uuid,new.owner_id;
    if parent is null then raise exception 'Linked record does not belong to this owner' using errcode='23514'; end if;
    if d ? 'property_id' and parent->>'property_id' is distinct from d->>'property_id' then
      raise exception 'Linked record belongs to another property' using errcode='23514';
    end if;
    if col<>'unit_id' and parent->>'unit_id' is not null and d->>'unit_id' is not null
        and parent->>'unit_id'<>d->>'unit_id' then
      raise exception 'Linked record belongs to another unit' using errcode='23514';
    end if;
  end loop;
  return new;
end $$;
notify pgrst,'reload schema';
