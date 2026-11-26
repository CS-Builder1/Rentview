begin;

-- A worker must atomically set destructive_pending with its token before
-- dispatching Storage/Auth. Rotation is safe only between acknowledged steps.
create or replace function public.claim_identity_deletion_worker(p_owner_id uuid, p_claim_token uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  claimed_owner uuid;
begin
  if p_claim_token is null or not exists (
    select 1 from public.account_deletion_requests where owner_id = p_owner_id
  ) then
    raise exception 'Deletion has not started or claim token is missing' using errcode = '23514';
  end if;

  insert into rentview_private.identity_deletion_workers as w (owner_id, claim_token)
  values (p_owner_id, p_claim_token)
  on conflict (owner_id) do update
    set claim_token = excluded.claim_token, claimed_at = clock_timestamp(), updated_at = clock_timestamp()
    where w.state = 'running' and not w.destructive_pending
      and w.updated_at < clock_timestamp() - interval '10 minutes'
  returning owner_id into claimed_owner;

  if claimed_owner is not null then return 'claimed'; end if;
  return (select w.state from rentview_private.identity_deletion_workers w where w.owner_id = p_owner_id);
end $$;

-- Renew the idle period and serialize rotation with ownership checks and
-- metadata updates performed in the same transaction by the wrapper RPCs.
create or replace function rentview_private.assert_identity_deletion_worker(p_owner_id uuid, p_claim_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update rentview_private.identity_deletion_workers w set updated_at = clock_timestamp()
  where w.owner_id = p_owner_id and w.claim_token = p_claim_token
    and w.state = 'running' and not w.destructive_pending;
  if not found then
    raise exception 'Deletion worker is missing, busy or needs review' using errcode = '42501';
  end if;
end $$;

commit;
