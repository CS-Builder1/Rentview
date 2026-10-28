-- Retry workers. Run AFTER applying backend_reliability migration.
-- Configure Vault push_hook_url/push_hook_secret to match send-push's
-- PUSH_HOOK_SECRET, and reminders_hook_url/reminders_hook_secret to match
-- send-reminders' CRON_SECRET. URLs end /functions/v1/send-push and
-- /functions/v1/send-reminders on YOUR Supabase project.
-- No credential belongs in a migration or a cron command.
--
-- send-reminders sends at most once per owner/day, after REMINDERS_LOCAL_HOUR
-- (default 9) in REMINDERS_TIMEZONE (default UTC). Frequent runs drain larger
-- portfolios and retry failed deliveries, rather than sending repeated digests.
-- Use America/St_Lucia for 09:00 Atlantic Standard Time if that is your chosen
-- portfolio reminder timezone. Users can request their own digest on demand.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job
where jobname in ('rentview-daily-reminders','rentview-reminder-worker','rentview-notification-worker');

select cron.schedule('rentview-reminder-worker','*/15 * * * *',
  'select public.dispatch_due_reminders();');
select cron.schedule('rentview-notification-worker','*/2 * * * *',
  'select public.dispatch_due_notifications();');
