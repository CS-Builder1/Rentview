create or replace view public.dispatch_jobs with (security_barrier=true) as
  select w.id as work_order_id, r.id as request_id, w.title,
    case when (public.can_manage_property(w.property_id) or (c.user_id=(select auth.uid()) and d.assignment_status <> 'declined'))
      then coalesce(w.description,r.description) else r.description end as description, w.priority,
    w.status as work_status, p.name as property_name,u.label as unit_label,
    concat_ws(', ',nullif(p.address_line1,''),nullif(p.address_line2,''),nullif(p.city,''),
      nullif(p.region,''),nullif(p.postal_code,''),nullif(p.country,'')) as address,
    v.id as vendor_id,coalesce(v.name,case when w.vendor_id is null and d.assignment_status='completed' then
      (select h.detail->>'vendor_name' from public.dispatch_history h where h.work_order_id=w.id
        and h.property_id=w.property_id and h.event in ('field_completed','cost_completed') and h.detail->>'vendor_name' is not null
        order by (h.detail->>'revision')::integer desc,h.created_at desc limit 1) end) as vendor_name,d.assignment_status,
    case when (public.can_manage_property(w.property_id) or (c.user_id=(select auth.uid()) and d.assignment_status <> 'declined')) then d.instructions end as instructions,d.visit_status,
    d.visit_start,d.visit_end,d.proposed_by,d.completion_notes,d.completion_photos,d.revision,
    c.user_id is not null as vendor_linked, d.field_completed_at,
    (d.visit_status='proposed' and d.assignment_status='accepted' and d.visit_start>now() and
      (public.can_manage_property(w.property_id) or
        (d.proposed_by is distinct from (select auth.uid()) and (
          (not d.proposed_by_tenant and r.tenant_user_id=(select auth.uid()) and public.is_tenant_of_lease(r.lease_id))
          or (c.user_id=(select auth.uid()) and (d.proposed_by_tenant or not exists(
            select from public.leases l where l.id=r.lease_id and l.tenant_user_id=r.tenant_user_id and public.lease_is_current(l)
          )))
        )))) is true as can_confirm
  from public.work_orders w
  join public.work_order_dispatch d on d.work_order_id=w.id
  join public.properties p on p.id=w.property_id and p.owner_id=w.owner_id
  left join public.units u on u.id=w.unit_id and u.property_id=p.id and u.owner_id=p.owner_id
  left join public.vendors v on v.id=w.vendor_id and v.owner_id=p.owner_id and (v.property_id is null or v.property_id=w.property_id)
  left join public.contractor_accounts c on c.vendor_id=v.id
  left join public.maintenance_requests r on r.work_order_id=w.id and r.owner_id=w.owner_id
    and r.property_id=w.property_id and r.unit_id=w.unit_id
  where (select public.current_account_is_active()) and (w.owner_id=(select auth.uid())
    or public.can_manage_property(w.property_id)
    or (c.user_id=(select auth.uid()) and d.assignment_status <> 'declined')
    or (r.tenant_user_id=(select auth.uid()) and public.can_access_request(r.id)));

create or replace function rentview_private.track_dispatch_order() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  previous_worker uuid;
  changed_vendor boolean := tg_op='INSERT' or new.vendor_id is distinct from old.vendor_id;
  action text;
begin
  if changed_vendor and new.vendor_id is not null and not exists(
    select from public.vendors v where v.id=new.vendor_id and v.owner_id=new.owner_id
      and (v.property_id is null or v.property_id=new.property_id)
  ) then raise exception 'Choose a vendor for this property'; end if;
  if tg_op='INSERT' then
    insert into public.work_order_dispatch(work_order_id,assignment_status,instructions)
    values(new.id,case when new.vendor_id is null then null when new.status='completed' then 'completed' else 'pending' end,
           new.dispatch_instructions);
  elsif changed_vendor then
    -- Foreign-key cleanup must not erase a finished repair or send fresh
    -- assignment alerts for an administrative deletion of a vendor.
    if new.vendor_id is null and (new.status in ('completed','cancelled') or new.completion_expense_id is not null
      or exists(select from public.work_order_dispatch where work_order_id=new.id and assignment_status='completed')) then
      return new;
    end if;
    if new.vendor_id is not null and (new.status in ('completed','cancelled') or new.completion_expense_id is not null)
      then raise exception 'This work order is finished'; end if;
    select user_id into previous_worker from public.contractor_accounts where vendor_id=old.vendor_id;
    update public.work_order_dispatch set
      assignment_status=case when new.vendor_id is not null then 'pending' end,
      instructions=new.dispatch_instructions,
      visit_status='none',visit_start=null,visit_end=null,proposed_by=null,proposed_by_tenant=null,
      field_completed_at=null,completion_notes=null,completion_photos='{}',
      revision=revision+1,updated_at=now() where work_order_id=new.id;
    if pg_trigger_depth()=1 and previous_worker is not null and previous_worker is distinct from auth.uid()
       and to_regprocedure('public.deliver_inbox_event(uuid,text,text,text,uuid,uuid,uuid,boolean)') is not null then
      perform public.deliver_inbox_event(previous_worker,'Assignment withdrawn',
        'A job is no longer assigned to you.','/contractor',new.property_id,null::uuid,null::uuid,true);
    end if;
  end if;
  if pg_trigger_depth()=1 and changed_vendor and (tg_op='UPDATE' or new.vendor_id is not null) then
    action:=case when new.vendor_id is null then 'unassigned' when tg_op='UPDATE' and old.vendor_id is not null then 'reassigned' else 'assigned' end;
    perform public.dispatch_record_event(new.id,action,'Repair assignment updated',
      case when new.vendor_id is null then 'A new contractor will be selected.' else 'Open the repair for assignment details.' end);
  end if;
  if tg_op='UPDATE' and not changed_vendor and new.dispatch_instructions is distinct from old.dispatch_instructions then
    update public.work_order_dispatch set instructions=new.dispatch_instructions,revision=revision+1,updated_at=now()
      where work_order_id=new.id;
    perform public.dispatch_record_event(new.id,'instructions_updated','Job instructions updated','Review the current instructions.',array['worker','management']);
  end if;
  if tg_op='UPDATE' and old.status is distinct from new.status then
    if new.status in ('completed','cancelled') then
      update public.work_order_dispatch set
        assignment_status=case when new.status='completed' and new.vendor_id is not null then 'completed' else assignment_status end,
        revision=revision+1,updated_at=now() where work_order_id=new.id;
      perform public.dispatch_record_event(new.id,case new.status when 'completed' then 'cost_completed' else 'cancelled' end,
        'Work order '||new.status,'The owner updated the job.',array['worker']);
    elsif old.status in ('completed','cancelled') then
      perform public.dispatch_record_event(new.id,'reopened','Repair reopened','The repair needs more work.',
        array['worker','management'],jsonb_build_object('prior_ratings',(
          select coalesce(jsonb_agg(jsonb_build_object('request_id',r.id,'rating',r.rating,'comment',r.rating_comment)),'[]'::jsonb)
          from public.maintenance_requests r where r.work_order_id=new.id and r.rating is not null)));
      update public.work_order_dispatch set assignment_status=case when new.vendor_id is null then null when assignment_status='completed' then 'pending' else assignment_status end,
        visit_status='none',visit_start=null,visit_end=null,proposed_by=null,proposed_by_tenant=null,
        completion_notes=null,completion_photos='{}',field_completed_at=null,revision=revision+1,updated_at=now()
        where work_order_id=new.id;
      update public.maintenance_requests r set
        status=case when new.status='in_progress' then 'in_progress'::public.request_status else 'acknowledged'::public.request_status end,
        resolved_at=null,rating=null,rating_comment=null
        where r.work_order_id=new.id and r.owner_id=new.owner_id and r.status in ('resolved','closed');
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.reopen_tenant_request(p_request_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare r public.maintenance_requests%rowtype; linked_status public.wo_status;
begin
  select * into r from public.maintenance_requests where id=p_request_id for update;
  if not found or auth.uid() is null or r.tenant_user_id is distinct from auth.uid() or not public.can_access_request(r.id)
    then raise exception 'Request not found' using errcode='42501'; end if;
  if length(trim(coalesce(p_reason,''))) not between 1 and 2000 then raise exception 'Explain what still needs attention' using errcode='23514'; end if;
  if r.status not in ('resolved','closed') then raise exception 'Only resolved or closed requests can be reopened' using errcode='23514'; end if;
  if r.work_order_id is not null then
    if not pg_try_advisory_xact_lock(hashtextextended('work-order-cost:'||r.work_order_id::text,613)) then
      raise exception 'Repair is being updated. Retry reopening shortly.' using errcode='40001'; end if;
    begin
      select status into linked_status from public.work_orders where id=r.work_order_id and owner_id=r.owner_id for update nowait;
    exception when lock_not_available then
      raise exception 'Repair is being updated. Retry reopening shortly.' using errcode='40001';
    end;
    perform public.dispatch_record_event(r.work_order_id,'reopened','Resident reopened the repair',
      'The tenant reported that the issue persists.',
      case when linked_status not in ('completed','cancelled') then array['worker'] else '{}'::text[] end,
      jsonb_build_object('request_id',r.id,'prior_rating',r.rating,'prior_rating_comment',r.rating_comment,'reason',trim(p_reason)));
    if linked_status not in ('completed','cancelled') then
      update public.work_order_dispatch set assignment_status='accepted',field_completed_at=null,
        completion_notes=null,completion_photos='{}',visit_status='none',visit_start=null,visit_end=null,
        proposed_by=null,proposed_by_tenant=null,revision=revision+1,updated_at=now()
      where work_order_id=r.work_order_id and assignment_status='completed';
    end if;
  else
    insert into public.dispatch_history(property_id,owner_id,actor_id,event,detail)
      values(r.property_id,r.owner_id,auth.uid(),'reopened',jsonb_build_object('request_id',r.id,'title',r.title,
             'prior_rating',r.rating,'prior_rating_comment',r.rating_comment,'reason',trim(p_reason)));
  end if;
  update public.maintenance_requests set
    status=case when linked_status is not null and linked_status not in ('completed','cancelled') then 'acknowledged'::public.request_status else 'submitted'::public.request_status end,
    work_order_id=case when linked_status is not null and linked_status not in ('completed','cancelled') then r.work_order_id end,
    resolved_at=null,rating=null,rating_comment=null where id=r.id;
  insert into public.request_messages(request_id,sender_id,body) values(r.id,auth.uid(),'Still not fixed: '||trim(p_reason));
end;
$$;

-- A worker can confirm the outcome of their own exact attempt even after a decline removed the job from their queue.
create function public.dispatch_action_saved(p_work_order uuid,p_revision integer,p_action text,p_notes text default null,p_photos text[] default '{}')
returns boolean language sql stable security definer set search_path='' as $$
  select public.current_account_is_active() and exists(select from public.dispatch_history h
    where h.work_order_id=p_work_order and h.actor_id=(select auth.uid())
      and (h.detail->>'revision')::bigint=p_revision::bigint+1
      and h.event=case p_action when 'complete' then 'field_completed' when 'accept' then 'accepted' when 'decline' then 'declined' end
      and (p_action<>'complete' or (h.detail->>'completion_notes'=trim(p_notes)
        and h.detail->'completion_photos'=to_jsonb(coalesce(p_photos,'{}'::text[])))));
$$;
revoke all on function public.dispatch_action_saved(uuid,integer,text,text,text[]) from public,anon;
grant execute on function public.dispatch_action_saved(uuid,integer,text,text,text[]) to authenticated;

-- A routing role is a default home. A later tenancy or management relationship
-- can establish a new home without removing existing contractor assignments.
create function public.contractor_open_owner_workspace() returns void
language plpgsql security definer set search_path='' as $$
begin
  if not public.current_account_is_active() or not exists(select from public.contractor_accounts where user_id=auth.uid()) then
    raise exception 'A linked contractor account is required' using errcode='42501'; end if;
  update public.profiles set role='owner' where id=auth.uid() and role in ('contractor','tenant');
end $$;
revoke all on function public.contractor_open_owner_workspace() from public,anon;
grant execute on function public.contractor_open_owner_workspace() to authenticated;

create function rentview_private.route_contractor_membership() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='leases' then
    if new.tenant_user_id is not null and public.lease_is_current(new) then
      update public.profiles set role='tenant' where id=new.tenant_user_id and role='contractor'
        and not exists(select from public.properties where owner_id=new.tenant_user_id)
        and not exists(select from public.property_managers where user_id=new.tenant_user_id);
    end if;
  elsif tg_table_name='properties' then
    update public.profiles set role='owner' where id=new.owner_id and role='contractor';
  else
    update public.profiles set role='owner' where id=new.user_id and role='contractor';
  end if;
  return null;
end $$;
revoke all on function rentview_private.route_contractor_membership() from public,anon,authenticated;
create trigger route_contractor_lease after insert or update of tenant_user_id on public.leases for each row execute function rentview_private.route_contractor_membership();
create trigger route_contractor_property after insert or update of owner_id on public.properties for each row execute function rentview_private.route_contractor_membership();
create trigger route_contractor_manager after insert on public.property_managers for each row execute function rentview_private.route_contractor_membership();
update public.profiles pr set role='owner' where role='contractor' and
  (exists(select from public.properties where owner_id=pr.id) or exists(select from public.property_managers where user_id=pr.id));
update public.profiles pr set role='tenant' where role='contractor' and exists(
  select from public.leases l where l.tenant_user_id=pr.id and public.lease_is_current(l));
