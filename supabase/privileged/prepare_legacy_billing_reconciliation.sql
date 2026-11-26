-- Operator-only bootstrap, BEFORE the trust migration, in an approved maintenance
-- window. This file only creates an empty evidence ledger; it never trusts old
-- subscription values or enables checkout. Do not put secrets/raw provider data
-- in evidence references. See BILLING_RECONCILIATION.md before inserting rows.
begin;
create schema if not exists rentview_private;
revoke all on schema rentview_private from public,anon;
create table if not exists rentview_private.legacy_billing_reconciliation (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  legacy_snapshot jsonb not null check(jsonb_typeof(legacy_snapshot)='object'),
  decision text not null check(decision in ('verified','rejected')),
  provider public.sub_provider,
  subscription_id text,
  customer_id text,
  plan public.plan_tier,
  status public.sub_status,
  period_end timestamptz,
  cancel_at_period_end boolean,
  provider_updated_at timestamptz,
  provider_evidence_ref text not null check(length(provider_evidence_ref) between 1 and 500),
  account_evidence_ref text not null check(length(account_evidence_ref) between 1 and 500),
  verified_at timestamptz not null default now(),
  verified_by text not null default session_user,
  check(decision<>'verified' or (provider is not null and subscription_id is not null and length(subscription_id) between 1 and 200
    and plan is not null and status is not null and cancel_at_period_end is not null and provider_updated_at is not null)),
  check(provider_updated_at is null or provider_updated_at<=verified_at+interval '5 minutes')
);
create unique index if not exists legacy_billing_verified_subscription_key
 on rentview_private.legacy_billing_reconciliation(provider,subscription_id) where decision='verified';
alter table rentview_private.legacy_billing_reconciliation enable row level security;
revoke all on rentview_private.legacy_billing_reconciliation from public,anon,authenticated,service_role;
commit;
