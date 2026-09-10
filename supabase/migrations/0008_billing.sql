-- RentView — billing support tables
--
-- The subscriptions table already exists (0001). This adds what the payment
-- webhooks need around it:
--
--   * billing_events — every verified webhook, kept for idempotency and for
--     answering "what did the provider actually say?" when a subscription
--     looks wrong. RLS is on with NO policies, so it is reachable only by the
--     service role the webhooks run as.
--   * user_id_for_email — Lemon Squeezy carries our user id through checkout
--     custom data, but PayPal's hosted subscribe link has no reliable way to
--     pass one, so that webhook falls back to matching the payer's email.

create table public.billing_events (
  id          uuid primary key default gen_random_uuid(),
  provider    sub_provider not null,
  event_id    text not null,
  event_type  text not null,
  owner_id    uuid references auth.users(id) on delete set null,
  payload     jsonb not null,
  received_at timestamptz not null default now(),
  unique (provider, event_id)
);

create index idx_billing_events_owner on public.billing_events(owner_id);

alter table public.billing_events enable row level security;

create or replace function public.user_id_for_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from auth.users
  where lower(email) = lower(trim(p_email))
  order by created_at
  limit 1;
$$;

revoke execute on function public.user_id_for_email(text)
  from public, anon, authenticated;
grant execute on function public.user_id_for_email(text) to service_role;
