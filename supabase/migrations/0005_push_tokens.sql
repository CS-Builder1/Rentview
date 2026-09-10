-- RentView — push notification tokens
--
-- One row per device that has granted notification permission. Tokens are
-- Expo push tokens (ExponentPushToken[...]), which the send-push Edge Function
-- posts to Expo's push service.
--
-- Registration goes through a SECURITY DEFINER RPC because a device can be
-- handed between accounts: the token is unique, so re-registering must be able
-- to TAKE OVER a row that currently belongs to a different user. A plain
-- upsert would be blocked by the row's own RLS policy. The function only ever
-- writes auth.uid() as the owner, so the takeover is always in the caller's
-- own favour and never exposes another account's row.

create table public.push_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  token      text not null unique,
  platform   text check (platform in ('ios', 'android', 'web')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_push_tokens_user on public.push_tokens(user_id);

create trigger trg_push_tokens_updated_at
  before update on public.push_tokens
  for each row execute function public.set_updated_at();

alter table public.push_tokens enable row level security;

-- Self-access only. Reads and deletes cover "my devices" and sign-out; the
-- send-push function reads across users with the service role.
create policy "own_select_push_tokens" on public.push_tokens
  for select using (user_id = auth.uid());
create policy "own_delete_push_tokens" on public.push_tokens
  for delete using (user_id = auth.uid());

create or replace function public.register_push_token(
  p_token text,
  p_platform text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if p_token is null or length(trim(p_token)) = 0 then
    raise exception 'Missing push token';
  end if;

  insert into push_tokens (user_id, token, platform)
  values (auth.uid(), trim(p_token), p_platform)
  on conflict (token) do update
    set user_id    = auth.uid(),
        platform   = coalesce(excluded.platform, push_tokens.platform),
        updated_at = now();
end;
$$;

revoke execute on function public.register_push_token(text, text) from public, anon;
grant execute on function public.register_push_token(text, text) to authenticated;
