-- Cache statement-constant identity checks without changing access rules.
-- This additive migration follows trust_and_operations; reviewed predicates
-- must match exactly, otherwise the entire transaction fails for review.
-- Cache only row-independent identity reads; all row-dependent predicates and
-- restrictive policies remain untouched. ALTER POLICY preserves roles, command,
-- permissiveness, grants and RLS flags. Fail if the exact reviewed expression
-- changed since the advisor snapshot, rather than guessing at new predicates.
begin;
do $optimize$
declare
  item record;
  actual_command "char";
  actual_using text;
  actual_check text;
  old_expression text;
begin
  for item in select * from (values
    ('properties','owner_select_properties','owner_id','r'),
    ('properties','owner_insert_properties','owner_id','a'),
    ('properties','owner_update_properties','owner_id','w'),
    ('properties','owner_delete_properties','owner_id','d'),
    ('units','owner_select_units','owner_id','r'),
    ('units','owner_insert_units','owner_id','a'),
    ('units','owner_update_units','owner_id','w'),
    ('units','owner_delete_units','owner_id','d'),
    ('leases','owner_select_leases','owner_id','r'),
    ('leases','owner_insert_leases','owner_id','a'),
    ('leases','owner_update_leases','owner_id','w'),
    ('leases','owner_delete_leases','owner_id','d'),
    ('vendors','owner_select_vendors','owner_id','r'),
    ('vendors','owner_insert_vendors','owner_id','a'),
    ('vendors','owner_update_vendors','owner_id','w'),
    ('vendors','owner_delete_vendors','owner_id','d'),
    ('assets','owner_select_assets','owner_id','r'),
    ('assets','owner_insert_assets','owner_id','a'),
    ('assets','owner_update_assets','owner_id','w'),
    ('assets','owner_delete_assets','owner_id','d'),
    ('work_orders','owner_select_work_orders','owner_id','r'),
    ('work_orders','owner_insert_work_orders','owner_id','a'),
    ('work_orders','owner_update_work_orders','owner_id','w'),
    ('work_orders','owner_delete_work_orders','owner_id','d'),
    ('inventory_items','owner_select_inventory_items','owner_id','r'),
    ('inventory_items','owner_insert_inventory_items','owner_id','a'),
    ('inventory_items','owner_update_inventory_items','owner_id','w'),
    ('inventory_items','owner_delete_inventory_items','owner_id','d'),
    ('work_order_parts','owner_select_work_order_parts','owner_id','r'),
    ('work_order_parts','owner_insert_work_order_parts','owner_id','a'),
    ('work_order_parts','owner_update_work_order_parts','owner_id','w'),
    ('work_order_parts','owner_delete_work_order_parts','owner_id','d'),
    ('expenses','owner_select_expenses','owner_id','r'),
    ('expenses','owner_insert_expenses','owner_id','a'),
    ('expenses','owner_update_expenses','owner_id','w'),
    ('expenses','owner_delete_expenses','owner_id','d'),
    ('tasks','owner_select_tasks','owner_id','r'),
    ('tasks','owner_insert_tasks','owner_id','a'),
    ('tasks','owner_update_tasks','owner_id','w'),
    ('tasks','owner_delete_tasks','owner_id','d'),
    ('maintenance_schedules','owner_select_maintenance_schedules','owner_id','r'),
    ('maintenance_schedules','owner_insert_maintenance_schedules','owner_id','a'),
    ('maintenance_schedules','owner_update_maintenance_schedules','owner_id','w'),
    ('maintenance_schedules','owner_delete_maintenance_schedules','owner_id','d'),
    ('documents','owner_select_documents','owner_id','r'),
    ('documents','owner_insert_documents','owner_id','a'),
    ('documents','owner_update_documents','owner_id','w'),
    ('documents','owner_delete_documents','owner_id','d'),
    ('subscriptions','owner_select_subscriptions','owner_id','r'),
    ('profiles','profiles_select_self','id','r'),
    ('profiles','profiles_update_self','id','w'),
    ('profiles','profiles_insert_self','id','a'),
    ('tenant_invites','owner_select_tenant_invites','owner_id','r'),
    ('tenant_invites','owner_delete_tenant_invites','owner_id','d'),
    ('rent_payments','owner_select_rent_payments','owner_id','r'),
    ('rent_payments','owner_insert_rent_payments','owner_id','a'),
    ('rent_payments','owner_update_rent_payments','owner_id','w'),
    ('rent_payments','owner_delete_rent_payments','owner_id','d'),
    ('announcements','owner_select_announcements','owner_id','r'),
    ('announcements','owner_insert_announcements','owner_id','a'),
    ('announcements','owner_update_announcements','owner_id','w'),
    ('announcements','owner_delete_announcements','owner_id','d'),
    ('notification_prefs','own_update_notification_prefs','user_id','w'),
    ('push_tokens','own_select_push_tokens','user_id','r'),
    ('push_tokens','own_delete_push_tokens','user_id','d'),
    ('notification_prefs','own_select_notification_prefs','user_id','r'),
    ('notification_prefs','own_insert_notification_prefs','user_id','a'),
    ('notification_prefs','own_delete_notification_prefs','user_id','d')
  ) as expected(table_name,policy_name,column_name,command) loop
    select p.polcmd, pg_catalog.pg_get_expr(p.polqual,p.polrelid),
           pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)
      into actual_command, actual_using, actual_check
      from pg_catalog.pg_policy p
      where p.polrelid=pg_catalog.to_regclass(pg_catalog.format('public.%I',item.table_name))
        and p.polname=item.policy_name;
    if not found then
      raise exception 'Reviewed policy not found: %.%',item.table_name,item.policy_name;
    end if;
    old_expression:=pg_catalog.format('(%I = auth.uid())',item.column_name);
    if actual_command::text is distinct from item.command
      or actual_using is distinct from (case when item.command in ('r','w','d') then old_expression end)
      or actual_check is distinct from (case when item.command in ('a','w') then old_expression end) then
      raise exception 'Reviewed policy changed: %.% (%,%,%)',
        item.table_name,item.policy_name,actual_command,actual_using,actual_check;
    end if;
    if item.command in ('r','d') then
      execute pg_catalog.format('alter policy %I on public.%I using (%I=(select auth.uid()))',item.policy_name,item.table_name,item.column_name);
    elsif item.command='a' then
      execute pg_catalog.format('alter policy %I on public.%I with check (%I=(select auth.uid()))',item.policy_name,item.table_name,item.column_name);
    else
      execute pg_catalog.format('alter policy %I on public.%I using (%I=(select auth.uid())) with check (%I=(select auth.uid()))',item.policy_name,item.table_name,item.column_name,item.column_name);
    end if;
  end loop;
end $optimize$;
commit;
