-- An unposted cancelled job can return unused parts without reopening the repair.
create or replace function public.remove_work_order_part(p_part_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare part public.work_order_parts%rowtype; w public.work_orders%rowtype;
begin
 if not public.current_account_is_active() then raise exception 'Not authenticated' using errcode='42501'; end if;
 select * into part from public.work_order_parts where id=p_part_id and owner_id=auth.uid();
 if not found then return; end if;
 select * into w from public.work_orders where id=part.work_order_id and owner_id=auth.uid() for update;
 select * into part from public.work_order_parts where id=p_part_id and owner_id=auth.uid() for update;
 if not found or part.removed_at is not null then return; end if;
 if w.status = 'completed' or w.completion_expense_id is not null then raise exception 'Parts cannot be returned after financial completion' using errcode='23514'; end if;
 if part.inventory_item_id is not null then
  update public.inventory_items set quantity=quantity+part.quantity where id=part.inventory_item_id and owner_id=auth.uid();
  insert into public.inventory_movements(owner_id,inventory_item_id,work_order_id,part_id,quantity_change,reason)
   values(part.owner_id,part.inventory_item_id,part.work_order_id,part.id,part.quantity,'restored');
 end if;
 update public.work_order_parts set removed_at=now() where id=part.id;
end;
$$;
