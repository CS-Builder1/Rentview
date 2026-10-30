begin;
-- Service-only billing reconciliation. Generated with the Supabase CLI.
-- This does not enable checkout or establish ownership from webhook metadata.
alter table public.billing_events add column if not exists subscription_id text;
alter table public.billing_events add column if not exists processing_error text;
update public.billing_events set subscription_id=coalesce(payload#>>'{data,id}',payload#>>'{resource,id}')
 where subscription_id is null and length(coalesce(payload#>>'{data,id}',payload#>>'{resource,id}')) between 1 and 200;
create index billing_events_subscription_pending_idx on public.billing_events(provider,subscription_id)
 where processing_state in ('pending','unmatched');

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
revoke all on function public.apply_billing_event(text,text,text,uuid,text,text,text,text,timestamptz,boolean,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.apply_billing_event(text,text,text,uuid,text,text,text,text,timestamptz,boolean,timestamptz,jsonb) to service_role;

create table rentview_private.billing_reconciliation_audit (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid references auth.users(id) on delete set null,
 provider public.sub_provider not null,
 subscription_id text not null,
 provider_event_at timestamptz not null,
 provider_evidence_ref text not null,
 account_evidence_ref text not null,
 verified_at timestamptz not null default now(),
 verified_by text not null default session_user
);
alter table rentview_private.billing_reconciliation_audit enable row level security;
revoke all on rentview_private.billing_reconciliation_audit from public,anon,authenticated;
grant select on rentview_private.billing_reconciliation_audit to service_role;

-- This is a trusted maintenance API, not a customer-facing checkout endpoint.
-- The caller MUST independently verify the current provider subscription and
-- original server-owned account association. Evidence references identify that
-- review in a protected audit system; they are never proof supplied by a client.
create or replace function public.reconcile_verified_billing_subscription(
 p_provider text,p_subscription_id text,p_owner_id uuid,p_customer_id text,
 p_plan text,p_status text,p_period_end timestamptz,p_cancel_at_period_end boolean,
 p_event_at timestamptz,p_provider_evidence_ref text,p_account_evidence_ref text
) returns uuid language plpgsql security definer set search_path='' as $$
declare prior public.billing_subscription_states%rowtype; audit_id uuid;
begin
 if p_provider is null or p_provider not in ('lemonsqueezy','paypal') or p_plan is null or p_plan not in ('free','pro')
    or p_status is null or p_status not in ('trialing','active','past_due','cancelled','expired')
    or coalesce(length(p_subscription_id),0) not between 1 and 200 or p_owner_id is null
    or p_event_at is null or p_event_at>now()+interval '5 minutes'
    or p_cancel_at_period_end is null
    or coalesce(length(trim(p_provider_evidence_ref)),0) not between 1 and 500
    or coalesce(length(trim(p_account_evidence_ref)),0) not between 1 and 500 then
   raise exception 'Verified provider snapshot and account evidence are required' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('billing-owner:'||p_owner_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('billing-sub:'||p_provider||':'||p_subscription_id,0));
 if not exists(select 1 from auth.users where id=p_owner_id) then
   raise exception 'Account is missing' using errcode='23514';
 end if;
 select * into prior from public.billing_subscription_states
   where provider=p_provider::public.sub_provider and subscription_id=p_subscription_id for update;
 if found and prior.owner_id is distinct from p_owner_id then
   raise exception 'Subscription account binding cannot change' using errcode='22023';
 end if;
 -- A factual webhook can require review after deletion preparation. Permit a
 -- current verified snapshot for the existing same-owner binding so that review
 -- can finish; deletion must still refuse any newly established subscription.
 if exists(select 1 from public.account_deletion_requests where owner_id=p_owner_id)
   and prior.owner_id is distinct from p_owner_id then
   raise exception 'Cannot create a subscription binding after deletion has started' using errcode='23514';
 end if;
 if prior.event_at>p_event_at or exists(select 1 from public.billing_events
   where provider=p_provider::public.sub_provider and subscription_id=p_subscription_id and occurred_at>p_event_at) then
   raise exception 'Provider snapshot is older than recorded billing evidence; verify again' using errcode='40001';
 end if;
 insert into rentview_private.billing_reconciliation_audit(owner_id,provider,subscription_id,provider_event_at,provider_evidence_ref,account_evidence_ref)
 values(p_owner_id,p_provider::public.sub_provider,p_subscription_id,p_event_at,trim(p_provider_evidence_ref),trim(p_account_evidence_ref))
 returning id into audit_id;
 insert into public.billing_subscription_states(provider,subscription_id,owner_id,customer_id,plan,status,period_end,cancel_at_period_end,event_at)
 values(p_provider::public.sub_provider,p_subscription_id,p_owner_id,p_customer_id,p_plan::public.plan_tier,p_status::public.sub_status,p_period_end,p_cancel_at_period_end,p_event_at)
 on conflict(provider,subscription_id) do update set customer_id=excluded.customer_id,plan=excluded.plan,
   status=excluded.status,period_end=excluded.period_end,cancel_at_period_end=excluded.cancel_at_period_end,event_at=excluded.event_at;
 insert into public.subscriptions(owner_id,provider,provider_subscription_id,provider_customer_id,plan,status,current_period_end,cancel_at_period_end,billing_verified_at)
 select p_owner_id,s.provider,s.subscription_id,s.customer_id,s.plan,s.status,s.period_end,s.cancel_at_period_end,now()
 from public.billing_subscription_states s where s.owner_id=p_owner_id
 order by (s.plan='pro' and (s.status in ('active','trialing','past_due') or (s.status='cancelled' and s.period_end>now()))) desc,
   (s.status in ('active','trialing','past_due')) desc,s.first_seen_at desc,s.event_at desc,s.subscription_id
 limit 1
 on conflict(owner_id) do update set provider=excluded.provider,provider_subscription_id=excluded.provider_subscription_id,
   provider_customer_id=excluded.provider_customer_id,plan=excluded.plan,status=excluded.status,
   current_period_end=excluded.current_period_end,cancel_at_period_end=excluded.cancel_at_period_end,billing_verified_at=excluded.billing_verified_at;
 update public.billing_events set processing_state='superseded',processed_at=now(),processing_error=null,owner_id=p_owner_id
   where provider=p_provider::public.sub_provider and subscription_id=p_subscription_id
     and occurred_at<=p_event_at and processing_state in ('pending','unmatched');
 return audit_id;
end $$;
revoke all on function public.reconcile_verified_billing_subscription(text,text,uuid,text,text,text,timestamptz,boolean,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.reconcile_verified_billing_subscription(text,text,uuid,text,text,text,timestamptz,boolean,timestamptz,text,text) to service_role;

-- Expose only the current actor's need for review, with no provider identifiers,
-- payloads or evidence references. It cannot grant entitlement or bind accounts.
create or replace function public.billing_reconciliation_pending()
returns boolean language sql stable security definer set search_path='' as $$
 select public.current_account_is_active() and (
   exists(select 1 from public.billing_events where owner_id=(select auth.uid()) and processing_state='pending' and processing_error is not null)
   or exists(select 1 from public.subscriptions where owner_id=(select auth.uid()) and provider_subscription_id is not null and billing_verified_at is null));
$$;
revoke all on function public.billing_reconciliation_pending() from public,anon;
grant execute on function public.billing_reconciliation_pending() to authenticated;

-- A conflicting/legacy unverified state must not permit deletion while the
-- provider might still be charging. Reconciliation is required before cleanup.
create or replace function rentview_private.billing_needs_reconciliation(p_owner_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.billing_events where owner_id=p_owner_id and processing_state='pending' and processing_error is not null)
   or exists(select 1 from public.subscriptions where owner_id=p_owner_id and provider_subscription_id is not null and billing_verified_at is null);
$$;
revoke all on function rentview_private.billing_needs_reconciliation(uuid) from public,anon,authenticated;

create or replace function public.prepare_identity_deletion(p_owner_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('billing-owner:'||p_owner_id::text,0));
 if rentview_private.billing_needs_reconciliation(p_owner_id) then
   raise exception 'Billing needs verification before deleting this account.' using errcode='P0001';
 end if;
 if exists(select 1 from public.billing_subscription_states where owner_id=p_owner_id and status in ('active','trialing','past_due') and not cancel_at_period_end)
   or exists(select 1 from public.subscriptions where owner_id=p_owner_id and status in ('active','trialing','past_due') and not cancel_at_period_end and provider_subscription_id is not null and billing_verified_at is not null) then
   raise exception 'Cancel your subscription before deleting this account so billing cannot continue.' using errcode='P0001';
 end if;
 insert into public.account_deletion_requests(owner_id) values(p_owner_id) on conflict do nothing;
end $$;

create or replace function rentview_private.guard_identity_deletion()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not pg_try_advisory_xact_lock(hashtextextended('billing-owner:'||old.id::text,0)) then
   raise exception 'Billing is being updated. Retry account deletion shortly.' using errcode='40001';
 end if;
 if exists(select 1 from public.account_deletion_requests where owner_id=old.id) then
   if rentview_private.billing_needs_reconciliation(old.id) then
     raise exception 'Billing needs verification before deleting this account.' using errcode='P0001';
   end if;
   if exists(select 1 from public.billing_subscription_states where owner_id=old.id and status in ('active','trialing','past_due') and not cancel_at_period_end)
     or exists(select 1 from public.subscriptions where owner_id=old.id and status in ('active','trialing','past_due') and not cancel_at_period_end and provider_subscription_id is not null and billing_verified_at is not null) then
     raise exception 'Cancel your subscription before deleting this account so billing cannot continue.' using errcode='P0001';
   end if;
 end if;
 return old;
end $$;

notify pgrst, 'reload schema';
commit;
