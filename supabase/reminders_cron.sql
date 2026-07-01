-- Daily warranty/maintenance reminder emails via the send-reminders function.
--
-- Prerequisites (set in Supabase dashboard → Edge Functions → Secrets):
--   RESEND_API_KEY   your Resend API key (required to actually send)
--   REMINDERS_FROM   optional, e.g. "RentView <reminders@yourdomain.com>"
--   CRON_SECRET      a random string; must match the value below
--
-- Then run this SQL (replace REPLACE_WITH_CRON_SECRET with your CRON_SECRET).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any previous schedule with the same name, then (re)create it.
select cron.unschedule('rentview-daily-reminders')
where exists (
  select 1 from cron.job where jobname = 'rentview-daily-reminders'
);

select cron.schedule(
  'rentview-daily-reminders',
  '0 13 * * *', -- 13:00 UTC daily (~09:00 Atlantic Standard Time)
  $$
  select net.http_post(
    url := 'https://blxkpwokmduxkfwlzexh.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', 'REPLACE_WITH_CRON_SECRET'
    ),
    body := '{}'::jsonb
  );
  $$
);
