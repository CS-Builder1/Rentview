-- RentView — per-user notification preferences
--
-- One optional row per user. A MISSING row means "everything on", so nobody
-- has to be back-filled and a new account needs no write to behave sensibly.
-- send-push reads these with the service role and drops muted recipients
-- before it ever builds a message.

create table public.notification_prefs (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  push_enabled  boolean not null default true,  -- master switch
  requests      boolean not null default true,  -- new requests, status changes
  messages      boolean not null default true,  -- messages on a request thread
  announcements boolean not null default true,  -- landlord broadcasts
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger trg_notification_prefs_updated_at
  before update on public.notification_prefs
  for each row execute function public.set_updated_at();

alter table public.notification_prefs enable row level security;

create policy "own_select_notification_prefs" on public.notification_prefs
  for select using (user_id = auth.uid());
create policy "own_insert_notification_prefs" on public.notification_prefs
  for insert with check (user_id = auth.uid());
create policy "own_update_notification_prefs" on public.notification_prefs
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own_delete_notification_prefs" on public.notification_prefs
  for delete using (user_id = auth.uid());
