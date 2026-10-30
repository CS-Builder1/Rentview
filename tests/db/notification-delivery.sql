-- Disposable local database only. All delivery fixtures roll back.
begin;
do $$ declare v_job_id uuid; first_claim public.notification_outbox%rowtype; next_claim public.notification_outbox%rowtype; begin
  insert into public.notification_outbox(event,row_id) values('request_updated',gen_random_uuid()) returning notification_outbox.id into v_job_id;
  select * into first_claim from public.claim_notification_batch(1,v_job_id);
  assert not public.finish_notification(v_job_id,gen_random_uuid(),false,'{}','not authorized',true),'terminal completion bypassed claim token';
  assert public.finish_notification(v_job_id,first_claim.claim_token,false,'{"push:fixture":{"channel":"push","status":"uncertain","retryable":false}}','Acceptance unknown; operator review required',true);
  assert (select status='failed' and attempts=1 and claim_token is null and deliveries ? 'push:fixture' from public.notification_outbox where notification_outbox.id=v_job_id),'terminal failure was retried or lost delivery evidence';
  update public.notification_outbox set next_attempt_at=now()-interval '1 second' where notification_outbox.id=v_job_id;
  select * into next_claim from public.claim_notification_batch(1,v_job_id);
  assert next_claim.id is null,'terminal failure was automatically resent';
end $$;
do $$ declare v_job_id uuid; current_claim public.notification_outbox%rowtype; begin
  insert into public.notification_outbox(event,row_id,status,attempts) values('request_updated',gen_random_uuid(),'pending',8) returning notification_outbox.id into v_job_id;
  perform public.claim_notification_batch(1,v_job_id);
  assert (select status='failed' and attempts=8 from public.notification_outbox where notification_outbox.id=v_job_id),'historical exhausted pending notification stayed pending forever';
  insert into public.notification_outbox(event,row_id) values('request_updated',gen_random_uuid()) returning notification_outbox.id into v_job_id;
  select * into current_claim from public.claim_notification_batch(1,v_job_id);
  assert public.finish_notification(v_job_id,current_claim.claim_token,false,'{}','rate limited');
  assert (select status='pending' and attempts=1 and next_attempt_at>now() from public.notification_outbox where notification_outbox.id=v_job_id),'default transient retry behavior changed';
end $$;
do $$ declare oid oid := 'public.finish_notification(uuid,uuid,boolean,jsonb,text,boolean)'::regprocedure; begin
  assert not has_function_privilege('anon',oid,'execute');
  assert not has_function_privilege('authenticated',oid,'execute');
  assert has_function_privilege('service_role',oid,'execute');
  assert to_regprocedure('public.finish_notification(uuid,uuid,boolean,jsonb,text)') is null,'ambiguous old overload remains';
end $$;
rollback;
