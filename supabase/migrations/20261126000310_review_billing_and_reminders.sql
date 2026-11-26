begin;

create or replace function public.apply_billing_event(
  p_provider text,p_event_id text,p_event_type text,p_owner_id uuid,p_subscription_id text,
  p_customer_id text,p_plan text,p_status text,p_period_end timestamptz,
  p_cancel_at_period_end boolean,p_occurred_at timestamptz,p_payload jsonb
) returns text language plpgsql security definer set search_path = '' as $$
declare
  prior public.billing_subscription_states%rowtype;
  saved public.billing_events%rowtype;
  resolved_owner uuid;
  result_state text := 'applied';
begin
  if p_provider not in ('lemonsqueezy','paypal') or p_plan not in ('free','pro')
     or p_status not in ('trialing','active','past_due','cancelled','expired')
     or coalesce(length(p_event_id),0) not between 1 and 500
     or coalesce(length(p_event_type),0) not between 1 and 200
     or coalesce(length(p_subscription_id),0) not between 1 and 200
     or p_occurred_at is null or p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or p_occurred_at > now() + interval '5 minutes' then
    raise exception 'Invalid billing event' using errcode='22023';
  end if;
  -- Use owner -> subscription -> row order everywhere. Identity deletion
  -- takes the owner lock before FK cascades; taking a subscription row first
  -- would invert the order and deadlock a concurrent provider delivery.
  select * into prior from public.billing_subscription_states
    where provider=p_provider::public.sub_provider and subscription_id=p_subscription_id;
  -- Checkout custom_data/custom_id is customer-controlled input. It can
  -- corroborate an existing service-owned binding, never establish one.
  resolved_owner := prior.owner_id;
  if prior.owner_id is not null and p_owner_id is not null and prior.owner_id <> p_owner_id then
    raise exception 'Subscription account binding cannot change' using errcode='22023';
  end if;
  if resolved_owner is not null then
    perform pg_advisory_xact_lock(hashtextextended('billing-owner:'||resolved_owner::text,0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('billing-sub:'||p_provider||':'||p_subscription_id,0));
  select * into prior from public.billing_subscription_states
    where provider=p_provider::public.sub_provider and subscription_id=p_subscription_id for update;
  if prior.owner_id is not null and resolved_owner is distinct from prior.owner_id then
    if p_owner_id is not null then
      raise exception 'Subscription account binding cannot change' using errcode='22023';
    end if;
    raise exception 'Subscription binding changed concurrently; retry this delivery' using errcode='40001';
  end if;
  if resolved_owner is not null and not exists(select 1 from auth.users where id=resolved_owner) then
    resolved_owner := null;
  end if;
  select * into saved from public.billing_events
    where provider=p_provider::public.sub_provider and event_id=p_event_id for update;
  if found and saved.processing_state not in ('pending','unmatched') then return 'duplicate'; end if;
  insert into public.billing_events(provider,event_id,event_type,owner_id,payload,occurred_at,processing_state,subscription_id)
  values(p_provider::public.sub_provider,p_event_id,p_event_type,resolved_owner,p_payload,p_occurred_at,'pending',p_subscription_id)
  on conflict(provider,event_id) do update set owner_id=excluded.owner_id,payload=excluded.payload,occurred_at=excluded.occurred_at,subscription_id=excluded.subscription_id;
  if resolved_owner is null then
    update public.billing_events set processing_state='unmatched',processed_at=null
    where provider=p_provider::public.sub_provider and event_id=p_event_id;
    return 'unmatched';
  end if;
  -- PayPal can omit next_billing_time on cancellation. Use only this
  -- subscription's previously verified paid-through date.
  if p_provider='paypal' and p_status='cancelled' and p_period_end is null
     and prior.plan='pro' and prior.status in ('trialing','active','past_due','cancelled') then
    p_period_end := prior.period_end;
  end if;
  -- Equal provider timestamps do not establish event order. In particular,
  -- second-precision updates may contain a cancellation AND an activation.
  -- Preserve both facts and require a current provider snapshot; arrival order
  -- or a locally invented status ranking must not decide paid access/deletion.
  if prior.event_at=p_occurred_at and
    row(prior.plan,prior.status,prior.period_end,prior.cancel_at_period_end)
      is distinct from row(p_plan::public.plan_tier,p_status::public.sub_status,p_period_end,coalesce(p_cancel_at_period_end,false)) then
    update public.billing_events set processing_state='pending',processed_at=null,
      processing_error='Equal provider timestamp has conflicting state; verify current provider subscription'
      where provider=p_provider::public.sub_provider and event_id=p_event_id;
    return 'ambiguous';
  end if;
  if prior.event_at is not null and p_occurred_at <= prior.event_at then
    result_state := 'stale';
  else
    insert into public.billing_subscription_states(provider,subscription_id,owner_id,customer_id,plan,status,period_end,cancel_at_period_end,event_at)
    values(p_provider::public.sub_provider,p_subscription_id,resolved_owner,p_customer_id,p_plan::public.plan_tier,p_status::public.sub_status,p_period_end,coalesce(p_cancel_at_period_end,false),p_occurred_at)
    on conflict(provider,subscription_id) do update set owner_id=excluded.owner_id,customer_id=excluded.customer_id,
      plan=excluded.plan,status=excluded.status,period_end=excluded.period_end,cancel_at_period_end=excluded.cancel_at_period_end,event_at=excluded.event_at;
    update public.billing_events set processing_state='superseded', processed_at=now(), processing_error=null
    where provider=p_provider::public.sub_provider and subscription_id=p_subscription_id
      and owner_id=resolved_owner and processing_state='pending' and processing_error is not null
      and occurred_at<p_occurred_at;
    -- Project access from ALL subscriptions. Cancelling an old provider cannot remove
    -- entitlement still granted by another paid subscription.
    insert into public.subscriptions(owner_id,provider,provider_subscription_id,provider_customer_id,plan,status,current_period_end,cancel_at_period_end,billing_verified_at)
    select resolved_owner,s.provider,s.subscription_id,s.customer_id,s.plan,s.status,s.period_end,s.cancel_at_period_end,now()
    from public.billing_subscription_states s where s.owner_id=resolved_owner
    order by (s.plan='pro' and (s.status in ('active','trialing','past_due') or (s.status='cancelled' and s.period_end>now()))) desc,
      (s.status in ('active','trialing','past_due')) desc,s.first_seen_at desc,s.event_at desc,s.subscription_id
    limit 1
    on conflict(owner_id) do update set provider=excluded.provider,provider_subscription_id=excluded.provider_subscription_id,
      provider_customer_id=excluded.provider_customer_id,plan=excluded.plan,status=excluded.status,
      current_period_end=excluded.current_period_end,cancel_at_period_end=excluded.cancel_at_period_end,billing_verified_at=excluded.billing_verified_at;
  end if;
  update public.billing_events set processing_state=result_state,processed_at=now(),processing_error=null
    where provider=p_provider::public.sub_provider and event_id=p_event_id;
  return result_state;
end; $$;

-- Repair previously stuck conflicts when a strictly newer verified event
-- already established the state of the same owner's subscription.
update public.billing_events e set processing_state='superseded', processed_at=now(), processing_error=null
from public.billing_subscription_states s
where s.provider=e.provider and s.subscription_id=e.subscription_id and s.owner_id=e.owner_id
  and e.processing_state='pending' and e.processing_error is not null and s.event_at>e.occurred_at;

create or replace function public.due_reminder_owners(p_today date,p_soon date,p_limit integer default 25)
returns table(owner_id uuid) language plpgsql security definer set search_path='' as $$
begin
  update public.reminder_deliveries r set status='failed',locked_at=null,claim_token=null,
    last_error=coalesce(r.last_error,'Reminder worker did not finish before the retry limit')
    where r.attempts>=8 and r.status='processing' and r.locked_at<now()-interval '10 minutes';
  return query with owners as (
    select a.owner_id from public.assets a where a.warranty_expiry between p_today and p_soon
    union select m.owner_id from public.maintenance_schedules m where m.is_active and m.next_due<=p_today
  ) select o.owner_id from owners o left join public.reminder_deliveries r on r.owner_id=o.owner_id and r.reminder_day=p_today
    where not exists (select 1 from public.account_deletion_requests d where d.owner_id=o.owner_id)
      and (r.id is null or (r.status='failed' and r.attempts<8 and r.next_attempt_at<=now())
      or (r.status='processing' and r.attempts<8 and r.locked_at<now()-interval '10 minutes'))
    order by o.owner_id limit greatest(1,least(coalesce(p_limit,25),100));
end;
$$;

create or replace function public.claim_reminder(p_owner_id uuid,p_day date)
returns public.reminder_deliveries language plpgsql security definer set search_path='' as $$
declare item public.reminder_deliveries%rowtype;
begin
  if exists(select 1 from public.account_deletion_requests d where d.owner_id=p_owner_id) then
    return null;
  end if;
  update public.reminder_deliveries set status='failed',locked_at=null,claim_token=null,
    last_error=coalesce(last_error,'Reminder worker did not finish before the retry limit')
    where owner_id=p_owner_id and reminder_day=p_day and attempts>=8 and status='processing' and locked_at<now()-interval '10 minutes';
  insert into public.reminder_deliveries(owner_id,reminder_day,locked_at,claim_token)
    values(p_owner_id,p_day,now(),gen_random_uuid()) on conflict do nothing;
  if found then select * into item from public.reminder_deliveries where owner_id=p_owner_id and reminder_day=p_day; return item; end if;
  update public.reminder_deliveries set status='processing',attempts=attempts+1,locked_at=now(),claim_token=gen_random_uuid()
    where owner_id=p_owner_id and reminder_day=p_day and attempts<8
      and ((status='failed' and next_attempt_at<=now()) or (status='processing' and locked_at<now()-interval '10 minutes')) returning * into item;
  return item;
end; $$;

commit;
