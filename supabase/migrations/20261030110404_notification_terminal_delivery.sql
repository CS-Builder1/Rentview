begin;
-- Explicit terminal outcomes prevent permanent/ambiguous delivery failures from
-- being replayed. Recover historical exhausted pending rows as visible failures.
create or replace function public.claim_notification_batch(p_limit integer default 5,p_id uuid default null)
returns setof public.notification_outbox language plpgsql security definer set search_path = '' as $$
begin
  -- A worker can die on its final claim. Preserve the exhausted record as
  -- failed instead of leaving it processing forever outside the claim filter.
  update public.notification_outbox set status='failed',locked_at=null,claim_token=null,receipt_pending=false,
    last_error=coalesce(last_error,'Delivery worker did not finish before the retry limit')
    where attempts>=8 and (status='pending' or status='processing' and locked_at<now()-interval '10 minutes');
  return query with picked as (
    select n.id from public.notification_outbox n
    where (p_id is null or n.id=p_id) and n.attempts<8
      and ((n.status='pending' and n.next_attempt_at<=now()) or (n.status='processing' and n.locked_at<now()-interval '10 minutes'))
    order by n.next_attempt_at,n.id for update skip locked limit greatest(1,least(coalesce(p_limit,5),20))
  ) update public.notification_outbox n set status='processing',attempts=n.attempts+1,locked_at=now(),claim_token=gen_random_uuid()
    from picked where n.id=picked.id returning n.*;
end;
$$;
revoke all on function public.claim_notification_batch(integer,uuid) from public,anon,authenticated;
grant execute on function public.claim_notification_batch(integer,uuid) to service_role;
-- Remove the old overload so service PostgREST calls are unambiguous. No browser
-- role can call either signature. Claim-token matching still guards every finish.
drop function public.finish_notification(uuid,uuid,boolean,jsonb,text);
create function public.finish_notification(p_id uuid,p_claim_token uuid,p_success boolean,p_deliveries jsonb,p_error text default null,p_terminal boolean default false)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.notification_outbox set
    status=case when p_success then 'sent' when p_terminal or attempts>=8 then 'failed' else 'pending' end,
    deliveries=coalesce(p_deliveries,'{}'::jsonb),
    receipt_pending=p_success and exists(select 1 from jsonb_each(coalesce(p_deliveries,'{}'::jsonb)) d where d.value->>'channel'='push' and d.value->>'status'='accepted'),
    last_error=left(p_error,500),locked_at=null,claim_token=null,
    completed_at=case when p_success then now() else null end,
    next_attempt_at=now()+make_interval(secs=>least(3600,power(2,least(attempts,8))::integer*30))
    where id=p_id and status='processing' and claim_token=p_claim_token;
  return found;
end; $$;
revoke all on function public.finish_notification(uuid,uuid,boolean,jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.finish_notification(uuid,uuid,boolean,jsonb,text,boolean) to service_role;

commit;
