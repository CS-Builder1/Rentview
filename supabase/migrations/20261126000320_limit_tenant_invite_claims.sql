-- Old client-generated codes can remain on existing leases. Preserve the claim
-- history and the original expiry of invites that have already expired.
update public.tenant_invites
set expires_at = least(expires_at, now())
where claimed_at is null and code !~ '^[0-9A-F]{32}$' and expires_at > now();

create table rentview_private.tenant_invite_claim_failures (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failed_at timestamptz[] not null check (cardinality(failed_at) between 1 and 10)
);
revoke all on rentview_private.tenant_invite_claim_failures from public, anon, authenticated, service_role;

-- Keep the eligibility and atomic lease mutation already installed on this
-- deployment. Only the public wrapper can invoke it on behalf of a claimant.
alter function public.claim_tenant_invite(text) set schema rentview_private;
alter function rentview_private.claim_tenant_invite(text) rename to claim_tenant_invite_checked;
revoke all on function rentview_private.claim_tenant_invite_checked(text) from public, anon, authenticated, service_role;

create function public.claim_tenant_invite(invite_code text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  claimant uuid := auth.uid();
  checked_at timestamptz;
  failures timestamptz[];
  error_code text;
  error_message text;
begin
  if claimant is null or not public.current_account_is_active() then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  -- Serialize the first attempt, too, when the claimant has no ledger row.
  perform pg_advisory_xact_lock(hashtextextended('tenant-invite-claims:' || claimant::text, 0));
  checked_at := clock_timestamp();
  select array(
    select attempt
    from rentview_private.tenant_invite_claim_failures f, unnest(f.failed_at) as attempt
    where f.user_id = claimant and attempt > checked_at - interval '10 minutes'
  ) into failures;

  if cardinality(failures) >= 10 then
    raise exception 'Too many invitation attempts. Try again in 10 minutes.' using errcode = 'P0001';
  end if;

  begin
    return rentview_private.claim_tenant_invite_checked(invite_code);
  exception when check_violation or insufficient_privilege then
    get stacked diagnostics error_code = returned_sqlstate, error_message = message_text;
  end;

  insert into rentview_private.tenant_invite_claim_failures(user_id, failed_at)
  values (claimant, array_append(failures, checked_at))
  on conflict (user_id) do update set failed_at = excluded.failed_at;

  -- PostgREST reports the same error to callers while committing this failure.
  -- Raising here would roll the ledger back together with the failed claim.
  perform set_config('response.status', case error_code when '42501' then '403' else '400' end, true);
  return json_build_object('code', error_code, 'message', error_message, 'details', null, 'hint', null);
end;
$$;
revoke all on function public.claim_tenant_invite(text) from public, anon, service_role;
grant execute on function public.claim_tenant_invite(text) to authenticated;
