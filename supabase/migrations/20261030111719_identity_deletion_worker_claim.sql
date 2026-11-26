begin;
-- Storage.remove addresses a name, not an immutable object version. Serialize
-- deleting-account workers before listing names so another worker cannot remove
-- a newly-created foreign object at a formerly owned name. This claim MUST NOT
-- expire automatically: an old HTTP delete can outlive any client-side timeout.
-- An interrupted/ambiguous destructive call needs operator reconciliation after
-- proving that worker and its provider request cannot still be running.
create table rentview_private.identity_deletion_workers (
 owner_id uuid primary key references auth.users(id) on delete cascade,
 claim_token uuid not null,
 state text not null default 'running' check(state in ('running','needs_review')),
 destructive_pending boolean not null default false,
 claimed_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp()
);
alter table rentview_private.identity_deletion_workers enable row level security;
revoke all on rentview_private.identity_deletion_workers from public,anon,authenticated,service_role;

create function public.claim_identity_deletion_worker(p_owner_id uuid,p_claim_token uuid)
returns text language plpgsql security definer set search_path='' as $$
declare inserted_owner uuid; existing_state text;
begin
 if p_claim_token is null or not exists(select 1 from public.account_deletion_requests where owner_id=p_owner_id) then
  raise exception 'Deletion has not started or claim token is missing' using errcode='23514';
 end if;
 insert into rentview_private.identity_deletion_workers(owner_id,claim_token)
  values(p_owner_id,p_claim_token) on conflict do nothing returning owner_id into inserted_owner;
 if inserted_owner is not null then return 'claimed'; end if;
 select w.state into existing_state from rentview_private.identity_deletion_workers w where w.owner_id=p_owner_id;
 -- No clock-based takeover. Even an abandoned running claim remains exclusive.
 return coalesce(existing_state,'running');
end $$;

create function rentview_private.assert_identity_deletion_worker(p_owner_id uuid,p_claim_token uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from rentview_private.identity_deletion_workers w
  where w.owner_id=p_owner_id and w.claim_token=p_claim_token
   and w.state='running' and not w.destructive_pending) then
  raise exception 'Deletion worker is missing, busy or needs review' using errcode='42501';
 end if;
end $$;
revoke all on function rentview_private.assert_identity_deletion_worker(uuid,uuid) from public,anon,authenticated,service_role;

create function public.begin_identity_deletion_step(p_owner_id uuid,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 update rentview_private.identity_deletion_workers w set destructive_pending=true,updated_at=clock_timestamp()
  where w.owner_id=p_owner_id and w.claim_token=p_claim_token and w.state='running' and not w.destructive_pending;
 return found;
end $$;
create function public.finish_identity_deletion_step(p_owner_id uuid,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 update rentview_private.identity_deletion_workers w set destructive_pending=false,updated_at=clock_timestamp()
  where w.owner_id=p_owner_id and w.claim_token=p_claim_token and w.state='running' and w.destructive_pending;
 return found;
end $$;
create function public.mark_identity_deletion_uncertain(p_owner_id uuid,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 update rentview_private.identity_deletion_workers w set state='needs_review',destructive_pending=true,updated_at=clock_timestamp()
  where w.owner_id=p_owner_id and w.claim_token=p_claim_token;
 return found;
end $$;
create function public.release_identity_deletion_worker(p_owner_id uuid,p_claim_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 delete from rentview_private.identity_deletion_workers w
  where w.owner_id=p_owner_id and w.claim_token=p_claim_token and w.state='running' and not w.destructive_pending;
 return found;
end $$;

-- Keep the tested ownership/captured-cleanup implementation behind token-checked
-- wrappers. Old deployed handlers fail closed instead of bypassing the claim.
revoke all on function public.owned_storage_paths(uuid,integer) from public,anon,authenticated,service_role;
revoke all on function public.forget_deleted_uploads(uuid,text[]) from public,anon,authenticated,service_role;
create function public.owned_storage_paths(p_owner_id uuid,p_claim_token uuid,p_limit integer default 100)
returns table(bucket_id text,name text) language plpgsql security definer set search_path='' as $$
begin
 perform rentview_private.assert_identity_deletion_worker(p_owner_id,p_claim_token);
 return query select p.bucket_id,p.name from public.owned_storage_paths(p_owner_id,p_limit) p;
end $$;
create function public.forget_deleted_uploads(p_owner_id uuid,p_claim_token uuid,p_paths text[])
returns void language plpgsql security definer set search_path='' as $$
begin
 perform rentview_private.assert_identity_deletion_worker(p_owner_id,p_claim_token);
 perform public.forget_deleted_uploads(p_owner_id,p_paths);
end $$;

do $$ declare signature text; begin
 foreach signature in array array[
  'public.claim_identity_deletion_worker(uuid,uuid)',
  'public.begin_identity_deletion_step(uuid,uuid)',
  'public.finish_identity_deletion_step(uuid,uuid)',
  'public.mark_identity_deletion_uncertain(uuid,uuid)',
  'public.release_identity_deletion_worker(uuid,uuid)',
  'public.owned_storage_paths(uuid,uuid,integer)',
  'public.forget_deleted_uploads(uuid,uuid,text[])'
 ] loop
  execute 'revoke all on function '||signature||' from public,anon,authenticated';
  execute 'grant execute on function '||signature||' to service_role';
 end loop;
end $$;

commit;
