-- RentView — database-triggered push
--
-- Notifications used to be fired by the client right after it wrote a row. If
-- that client died in between — lost signal, killed app, crash — the row stood
-- but nobody was told. Now the DATABASE fires them: the same transaction that
-- writes the row queues the HTTP call through pg_net, so a notification cannot
-- be skipped and cannot fire for a write that rolled back.
--
-- Config lives in Supabase Vault (`push_hook_url`, `push_hook_secret`) rather
-- than in this file, so no secret is ever committed. When either is missing —
-- a fresh clone, a local stack — notify_push() simply returns and the app runs
-- with notifications off.

create extension if not exists pg_net;

create or replace function public.push_hook_config()
returns table (hook_url text, hook_secret text)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select decrypted_secret from vault.decrypted_secrets
      where name = 'push_hook_url' order by created_at desc limit 1),
    (select decrypted_secret from vault.decrypted_secrets
      where name = 'push_hook_secret' order by created_at desc limit 1);
$$;

revoke execute on function public.push_hook_config()
  from public, anon, authenticated;

-- Queues one call to the send-push Edge Function. pg_net writes the request to
-- its own queue table, so it inherits this transaction: commit sends it, a
-- rollback discards it.
create or replace function public.notify_push(
  p_event   text,
  p_id      uuid,
  p_actor   uuid,
  p_preview text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg record;
begin
  select * into cfg from public.push_hook_config();
  if cfg.hook_url is null or cfg.hook_secret is null then
    return;
  end if;

  perform net.http_post(
    url     := cfg.hook_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', cfg.hook_secret
    ),
    body    := jsonb_build_object(
      'event',   p_event,
      'id',      p_id,
      'actor',   p_actor,
      'preview', p_preview
    )
  );
end;
$$;

revoke execute on function public.notify_push(text, uuid, uuid, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Triggers. Each passes the ACTOR; send-push derives the recipient as the
-- other participant, so nobody is ever notified about their own action.
-- ---------------------------------------------------------------------------

create or replace function public.trg_push_request_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.notify_push('request_created', new.id, new.tenant_user_id);
  return new;
end;
$$;

revoke execute on function public.trg_push_request_created()
  from public, anon, authenticated;

create trigger trg_push_request_created
  after insert on public.maintenance_requests
  for each row execute function public.trg_push_request_created();

-- Covers the owner's own status edits AND the mirror from a work order, since
-- both land here as a status change.
create or replace function public.trg_push_request_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.notify_push(
    'request_updated', new.id, coalesce(auth.uid(), new.owner_id)
  );
  return new;
end;
$$;

revoke execute on function public.trg_push_request_status()
  from public, anon, authenticated;

create trigger trg_push_request_status
  after update on public.maintenance_requests
  for each row
  when (old.status is distinct from new.status)
  execute function public.trg_push_request_status();

create or replace function public.trg_push_request_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.notify_push(
    'request_message', new.request_id, new.sender_id, left(new.body, 140)
  );
  return new;
end;
$$;

revoke execute on function public.trg_push_request_message()
  from public, anon, authenticated;

create trigger trg_push_request_message
  after insert on public.request_messages
  for each row execute function public.trg_push_request_message();

create or replace function public.trg_push_announcement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.notify_push('announcement', new.id, new.owner_id);
  return new;
end;
$$;

revoke execute on function public.trg_push_announcement()
  from public, anon, authenticated;

create trigger trg_push_announcement
  after insert on public.announcements
  for each row execute function public.trg_push_announcement();
