-- Disposable local database only. Fixtures and injected failures roll back.
begin;
insert into auth.users(id,email) values
 ('50000000-0000-4000-8000-000000000001','billing-fixture@example.test'),
 ('50000000-0000-4000-8000-000000000002','billing-retry@example.test'),
 ('50000000-0000-4000-8000-000000000003','deletion-fixture@example.test') on conflict(id) do nothing;

-- Trusted binding fixtures emulate a backend-created checkout association, not
-- a customer-supplied webhook owner hint. Unbound webhooks must stay unmatched.
insert into public.billing_subscription_states(provider,subscription_id,owner_id,customer_id,plan,status,event_at) values
 ('lemonsqueezy','fixture-ls','50000000-0000-4000-8000-000000000001','customer','free','expired',now()-interval '1 hour'),
 ('paypal','fixture-pp','50000000-0000-4000-8000-000000000001','customer','free','expired',now()-interval '1 hour'),
 ('lemonsqueezy','fixture-retry','50000000-0000-4000-8000-000000000002','customer','free','expired',now()-interval '1 hour'),
 ('paypal','fixture-deleting','50000000-0000-4000-8000-000000000003','customer','free','expired',now()-interval '1 hour');


do $$ declare result text; person uuid := '50000000-0000-4000-8000-000000000001'; begin
 result := public.apply_billing_event('lemonsqueezy','first','subscription_created',person,'fixture-ls','customer','pro','active',now()+interval '1 month',false,now()-interval '3 minutes','{"fixture":true}');
 assert result='applied';
 assert (select plan='pro' and billing_verified_at is not null from public.subscriptions where owner_id=person);
 result := public.apply_billing_event('lemonsqueezy','first','subscription_created',person,'fixture-ls','customer','pro','active',now()+interval '1 month',false,now()-interval '3 minutes','{"fixture":true}');
 assert result='duplicate','duplicate webhook must be a no-op';
 result := public.apply_billing_event('lemonsqueezy','old','subscription_expired',person,'fixture-ls','customer','free','expired',now(),false,now()-interval '4 minutes','{"fixture":true}');
 assert result='stale';
 assert (select status='active' from public.subscriptions where owner_id=person),'old event reverted newer state';
 perform public.apply_billing_event('paypal','new-provider','BILLING.SUBSCRIPTION.ACTIVATED',person,'fixture-pp','customer','pro','active',now()+interval '1 month',false,now()-interval '2 minutes','{}');
 perform public.apply_billing_event('lemonsqueezy','cancel-old','subscription_cancelled',person,'fixture-ls','customer','pro','cancelled',now()+interval '1 month',true,now()-interval '1 minute','{}');
 assert (select provider='paypal' and status='active' and plan='pro' from public.subscriptions where owner_id=person),'old provider cancellation replaced a paid subscription';
 begin
  perform public.apply_billing_event('paypal','rebind','BILLING.SUBSCRIPTION.ACTIVATED','50000000-0000-4000-8000-000000000002','fixture-pp','customer','pro','active',null,false,now(),'{}');
  raise exception 'subscription account binding changed';
 exception when invalid_parameter_value then null; end;
 assert not exists(select 1 from public.billing_events where event_id='rebind');
 result := public.apply_billing_event('paypal','unmatched','BILLING.SUBSCRIPTION.ACTIVATED',null,'fixture-unmatched','customer','pro','active',null,false,now(),'{}');
 assert result='unmatched';
 assert exists(select 1 from public.billing_events where event_id='unmatched' and processing_state='unmatched' and owner_id is null);
 result := public.apply_billing_event('paypal','forged-first-binding','BILLING.SUBSCRIPTION.ACTIVATED',person,'fixture-attacker-chosen','customer','pro','active',null,false,now(),'{}');
 assert result='unmatched','customer owner hint established a trusted first binding';
 assert not exists(select 1 from public.billing_subscription_states where subscription_id='fixture-attacker-chosen'),'unbound delivery created authoritative state';
 assert exists(select 1 from public.billing_events where event_id='forged-first-binding' and owner_id is null and processing_state='unmatched');
end $$;

create function pg_temp.reject_fixture_subscription() returns trigger language plpgsql as $$ begin
 if new.owner_id='50000000-0000-4000-8000-000000000002' then raise exception 'injected subscription failure'; end if; return new;
end $$;
create trigger reject_fixture_subscription before insert or update on public.subscriptions for each row execute function pg_temp.reject_fixture_subscription();
do $$ begin
 begin
  perform public.apply_billing_event('lemonsqueezy','retryable','subscription_created','50000000-0000-4000-8000-000000000002','fixture-retry','customer','pro','active',null,false,now(),'{}');
  raise exception 'fault injection did not run';
 exception when raise_exception then assert sqlerrm='injected subscription failure'; end;
 assert not exists(select 1 from public.billing_events where event_id='retryable'),'failed entitlement write consumed dedupe event';
 assert exists(select 1 from public.billing_subscription_states where subscription_id='fixture-retry' and plan='free' and status='expired' and event_at=now()-interval '1 hour'),'failed event changed trusted binding state';
end $$;
drop trigger reject_fixture_subscription on public.subscriptions;
do $$ begin
 assert public.apply_billing_event('lemonsqueezy','retryable','subscription_created','50000000-0000-4000-8000-000000000002','fixture-retry','customer','pro','active',null,false,now(),'{}')='applied';
end $$;

do $$ declare job_id uuid; first_claim public.notification_outbox%rowtype; second_claim public.notification_outbox%rowtype; begin
 insert into public.notification_outbox(event,row_id,actor_id) values('request_updated',gen_random_uuid(),'50000000-0000-4000-8000-000000000001') returning id into job_id;
 select * into first_claim from public.claim_notification_batch(1,job_id);
 assert first_claim.id=job_id and first_claim.attempts=1;
 select * into second_claim from public.claim_notification_batch(1,job_id);
 assert second_claim.id is null,'in-flight job claimed twice';
 assert not public.finish_notification(job_id,gen_random_uuid(),true,'{}',null),'wrong claim token finished work';
 assert public.finish_notification(job_id,first_claim.claim_token,false,'{"fixture":{"status":"accepted"}}','transient failure');
 assert (select status='pending' and attempts=1 and deliveries ? 'fixture' from public.notification_outbox where id=job_id);
 update public.notification_outbox set next_attempt_at=now()-interval '1 second' where id=job_id;
 select * into second_claim from public.claim_notification_batch(1,job_id);
 assert second_claim.attempts=2 and second_claim.claim_token<>first_claim.claim_token;
 assert not public.finish_notification(job_id,first_claim.claim_token,true,'{}',null),'stale worker overwrote new claim';
 assert public.finish_notification(job_id,second_claim.claim_token,true,'{}',null);
end $$;

do $$ declare claim public.reminder_deliveries%rowtype; duplicate public.reminder_deliveries%rowtype; begin
 select * into claim from public.claim_reminder('50000000-0000-4000-8000-000000000001',current_date);
 select * into duplicate from public.claim_reminder('50000000-0000-4000-8000-000000000001',current_date);
 assert duplicate.id is null,'parallel reminder claimed twice';
 assert public.finish_reminder(claim.id,claim.claim_token,true,'fixture-provider-id',null);
 select * into duplicate from public.claim_reminder('50000000-0000-4000-8000-000000000001',current_date);
 assert duplicate.id is null,'daily digest resent';
end $$;

do $$ declare f record; begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('apply_billing_event','claim_notification_batch','finish_notification','claim_reminder','finish_reminder','due_reminder_owners','prepare_identity_deletion','owned_storage_paths','forget_deleted_uploads','dispatch_due_notifications','dispatch_due_reminders') loop
  assert not has_function_privilege('authenticated',f.oid,'execute'),'browser can call backend-only function';
  assert not has_function_privilege('anon',f.oid,'execute'),'anonymous can call backend-only function';
  assert has_function_privilege('service_role',f.oid,'execute');
 end loop;
 assert not has_table_privilege('authenticated','public.billing_subscription_states','select');
 assert not has_table_privilege('authenticated','public.notification_outbox','select');
end $$;

insert into public.properties(owner_id,name) values('50000000-0000-4000-8000-000000000003','Present before deletion');
select public.prepare_identity_deletion('50000000-0000-4000-8000-000000000003');
select set_config('request.jwt.claims','{"role":"authenticated","sub":"50000000-0000-4000-8000-000000000003"}',true);
select set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000003',true);
set local role authenticated;
do $$ begin
 assert (select count(*)=0 from public.properties),'deleting user retained direct reads';
 begin
  insert into public.properties(owner_id,name) values('50000000-0000-4000-8000-000000000003','blocked during deletion');
  raise exception 'deleting user could write';
 exception when insufficient_privilege then null; end;
 begin
  perform public.owned_storage_paths('50000000-0000-4000-8000-000000000001',100);
  raise exception 'browser could list foreign uploads';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Trust predicates deny direct reads and definer access during cleanup, not
-- merely writes. No copied JWT can revive the identity afterwards either.
do $$ begin
 assert not public.current_account_is_active(),'deleting account still active';
 assert (select count(*)=0 from public.tenant_lease_details),'deleting tenant can read lease view';
end $$;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);

do $$ declare person uuid:='50000000-0000-4000-8000-000000000003'; begin
 -- A factual activation during cleanup is recorded and blocks final Auth delete.
 assert public.apply_billing_event('paypal','late-activation','BILLING.SUBSCRIPTION.ACTIVATED',person,'fixture-deleting','customer','pro','active',now()+interval '1 month',false,now(),'{}')='applied';
 begin
  perform public.prepare_identity_deletion(person);
  raise exception 'renewable billing did not block deletion preparation';
 exception when raise_exception then assert sqlerrm like 'Cancel your subscription%'; end;
 begin
  delete from auth.users where id=person;
  raise exception 'renewable billing did not block final Auth deletion';
 exception when raise_exception then assert sqlerrm like 'Cancel your subscription%'; end;
 assert exists(select 1 from auth.users where id=person),'blocked deletion removed identity';
 assert public.apply_billing_event('paypal','late-cancellation','BILLING.SUBSCRIPTION.CANCELLED',person,'fixture-deleting','customer','pro','cancelled',now()+interval '1 month',true,now()+interval '1 second','{}')='applied';
 perform public.prepare_identity_deletion(person);
 delete from auth.users where id=person;
 assert not exists(select 1 from auth.users where id=person),'cancelled identity did not delete';
end $$;

do $$ declare job_id uuid; claim public.notification_outbox%rowtype; begin
 insert into public.notification_outbox(event,row_id,status,attempts,locked_at,claim_token)
 values('request_updated',gen_random_uuid(),'processing',8,now()-interval '11 minutes',gen_random_uuid()) returning id into job_id;
 perform public.claim_notification_batch(1,job_id);
 assert (select status='failed' and claim_token is null from public.notification_outbox where id=job_id),'final crashed notification stayed processing';
 insert into public.notification_outbox(event,row_id) values('request_updated',gen_random_uuid()) returning id into job_id;
 select * into claim from public.claim_notification_batch(1,job_id);
 assert public.finish_notification(job_id,claim.claim_token,true,'{"fixture":{"channel":"push","status":"accepted","ticket_id":"fixture-ticket"}}',null);
 assert (select receipt_pending from public.notification_outbox where id=job_id),'accepted push ticket not queued for receipt polling';
end $$;

do $$ begin
 insert into public.reminder_deliveries(owner_id,reminder_day,status,attempts,locked_at,claim_token)
 values('50000000-0000-4000-8000-000000000002',current_date,'processing',8,now()-interval '11 minutes',gen_random_uuid());
 perform public.due_reminder_owners(current_date,current_date+60,25);
 assert (select status='failed' and claim_token is null from public.reminder_deliveries where owner_id='50000000-0000-4000-8000-000000000002' and reminder_day=current_date),'final crashed reminder stayed processing';
end $$;
rollback;
