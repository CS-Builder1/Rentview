-- Disposable loopback database only. All principals/evidence are synthetic and
-- every record/failure injection rolls back. No provider API requests are made.
begin;
insert into auth.users(id,email) values
 ('b1100000-0000-4000-8000-000000000001','billing-reconcile-a@example.test'),
 ('b1100000-0000-4000-8000-000000000002','billing-reconcile-b@example.test'),
 ('b1100000-0000-4000-8000-000000000003','billing-reconcile-failure@example.test'),
 ('b1100000-0000-4000-8000-000000000004','billing-reconcile-deleting@example.test');

do $$ declare person uuid:='b1100000-0000-4000-8000-000000000001'; stamp timestamptz:=date_trunc('second',now())-interval '1 minute'; result text; audit_id uuid; begin
 result:=public.apply_billing_event('paypal','unbound-event','BILLING.SUBSCRIPTION.ACTIVATED',
  'b1100000-0000-4000-8000-000000000002','verified-fixture','customer','pro','active',now()+interval '1 month',false,stamp,'{}');
 assert result='unmatched';
 assert not exists(select 1 from public.billing_subscription_states where subscription_id='verified-fixture'),'customer hint established a binding';
 audit_id:=public.reconcile_verified_billing_subscription('paypal','verified-fixture',person,'customer','pro','active',now()+interval '1 month',false,stamp,'synthetic-provider:current-record','synthetic-account:server-checkout-record');
 assert audit_id is not null;
 assert (select plan='pro' and billing_verified_at is not null from public.subscriptions where owner_id=person);
 assert (select processing_state='superseded' and owner_id=person from public.billing_events where event_id='unbound-event');
 assert (select owner_id=person from public.billing_subscription_states where subscription_id='verified-fixture');
 result:=public.apply_billing_event('paypal','same-second-cancel','BILLING.SUBSCRIPTION.CANCELLED',person,'verified-fixture','customer','pro','cancelled',now()+interval '1 month',true,stamp,'{}');
 assert result='ambiguous','same-second cancellation was silently discarded';
 assert (select processing_state='pending' and processed_at is null and processing_error is not null from public.billing_events where event_id='same-second-cancel');
 assert (select status='active' from public.billing_subscription_states where subscription_id='verified-fixture'),'arrival order arbitrarily chose conflicting state';
 assert rentview_private.billing_needs_reconciliation(person);
 begin perform public.prepare_identity_deletion(person); raise exception 'unresolved billing allowed deletion';
 exception when raise_exception then assert sqlerrm='Billing needs verification before deleting this account.'; end;
 begin
  perform public.reconcile_verified_billing_subscription('paypal','verified-fixture','b1100000-0000-4000-8000-000000000002','customer','pro','active',null,false,stamp,'provider','account');
  raise exception 'reconciliation rebound an existing subscription';
 exception when invalid_parameter_value then null; end;
 begin
  perform public.reconcile_verified_billing_subscription('paypal','verified-fixture',person,'customer','pro','active',null,false,stamp-interval '1 second','provider','account');
  raise exception 'stale current snapshot overwrote evidence';
 exception when serialization_failure then null; end;
 perform public.reconcile_verified_billing_subscription('paypal','verified-fixture',person,'customer','pro','cancelled',now()+interval '1 month',true,stamp,'synthetic-provider:cancelled-current','synthetic-account:server-checkout-record');
 assert not rentview_private.billing_needs_reconciliation(person);
 assert (select status='cancelled' and plan='pro' from public.subscriptions where owner_id=person),'current snapshot did not preserve cancelled paid-through access';
 assert (select processing_state='superseded' and processing_error is null from public.billing_events where event_id='same-second-cancel');
 assert public.apply_billing_event('paypal','same-second-cancel','BILLING.SUBSCRIPTION.CANCELLED',person,'verified-fixture','customer','pro','cancelled',now()+interval '1 month',true,stamp,'{}')='duplicate';
 -- A genuinely distinct, equally timed event still needs current provider
 -- evidence; this conservative gate never invents event/status ordering.
 assert public.apply_billing_event('paypal','same-second-active','BILLING.SUBSCRIPTION.ACTIVATED',person,'verified-fixture','customer','pro','active',now()+interval '1 month',false,stamp,'{}')='ambiguous';
end $$;

-- Deletion preparation can precede a later, equally timed conflicting delivery.
-- The existing binding must remain reconcilable without reopening checkout or
-- granting any authority to the event's customer-supplied owner hint.
do $$ declare person uuid:='b1100000-0000-4000-8000-000000000004'; stamp timestamptz:=date_trunc('second',now())-interval '1 minute'; begin
 perform public.reconcile_verified_billing_subscription('paypal','deleting-existing',person,'customer','pro','cancelled',now()+interval '1 month',true,stamp,'synthetic-provider:cancelled-before-delete','synthetic-account:original-binding');
 perform public.prepare_identity_deletion(person);
 assert exists(select 1 from public.account_deletion_requests where owner_id=person),'deletion fixture has no tombstone';
 assert public.apply_billing_event('paypal','deleting-timestamp-conflict','BILLING.SUBSCRIPTION.ACTIVATED',person,'deleting-existing','customer','pro','active',now()+interval '1 month',false,stamp,'{}')='ambiguous';
 assert rentview_private.billing_needs_reconciliation(person),'late conflicting event did not hold deletion';
 begin perform public.prepare_identity_deletion(person); raise exception 'ambiguous billing allowed deletion preparation';
 exception when raise_exception then assert sqlerrm='Billing needs verification before deleting this account.'; end;
 begin delete from auth.users where id=person; raise exception 'ambiguous billing allowed final deletion';
 exception when raise_exception then assert sqlerrm='Billing needs verification before deleting this account.'; end;
 begin
  perform public.reconcile_verified_billing_subscription('paypal','deleting-new-binding',person,'customer','pro','active',null,false,stamp,'synthetic-provider:new-subscription','synthetic-account:unrelated-new-binding');
  raise exception 'deleting account established a new subscription binding';
 exception when check_violation then null; end;
 assert not exists(select 1 from public.billing_subscription_states where subscription_id='deleting-new-binding');
 assert not exists(select 1 from rentview_private.billing_reconciliation_audit where subscription_id='deleting-new-binding'),'rejected new binding retained audit/projection work';
 perform public.reconcile_verified_billing_subscription('paypal','deleting-existing',person,'customer','pro','cancelled',now()+interval '1 month',true,stamp,'synthetic-provider:current-cancelled-after-conflict','synthetic-account:original-binding');
 assert not rentview_private.billing_needs_reconciliation(person),'existing-binding reconciliation remained blocked by deletion tombstone';
 assert (select processing_state='superseded' and processing_error is null from public.billing_events where event_id='deleting-timestamp-conflict');
 assert (select owner_id=person and status='cancelled' from public.billing_subscription_states where subscription_id='deleting-existing'),'existing immutable owner changed during reconciliation';
 perform public.prepare_identity_deletion(person);
 delete from auth.users where id=person;
 assert not exists(select 1 from auth.users where id=person),'reconciled cancelled account could not complete database deletion';
end $$;

select set_config('request.jwt.claim.sub','b1100000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"b1100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
do $$ begin
 assert public.billing_reconciliation_pending(),'owner cannot see their pending billing review';
 begin
  perform public.reconcile_verified_billing_subscription('paypal','browser-chosen','b1100000-0000-4000-8000-000000000001',null,'pro','active',null,false,now(),'forged','forged');
  raise exception 'browser reached trusted reconciliation';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','b1100000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"b1100000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
do $$ begin assert not public.billing_reconciliation_pending(),'other owner learned foreign reconciliation state'; end $$;
reset role;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);

create function pg_temp.reject_reconcile_projection() returns trigger language plpgsql as $$ begin
 if new.owner_id='b1100000-0000-4000-8000-000000000003' then raise exception 'injected reconciliation projection failure'; end if; return new;
end $$;
create trigger reject_reconcile_projection before insert or update on public.subscriptions for each row execute function pg_temp.reject_reconcile_projection();
do $$ begin
 begin
  perform public.reconcile_verified_billing_subscription('paypal','atomic-failure','b1100000-0000-4000-8000-000000000003',null,'pro','active',null,false,now(),'synthetic-provider','synthetic-account');
  raise exception 'injected failure did not run';
 exception when raise_exception then assert sqlerrm='injected reconciliation projection failure'; end;
 assert not exists(select 1 from public.billing_subscription_states where subscription_id='atomic-failure'),'failed projection retained trusted binding';
 assert not exists(select 1 from rentview_private.billing_reconciliation_audit where subscription_id='atomic-failure'),'failed projection consumed evidence audit';
end $$;
drop trigger reject_reconcile_projection on public.subscriptions;

do $$ declare f regprocedure:='public.reconcile_verified_billing_subscription(text,text,uuid,text,text,text,timestamptz,boolean,timestamptz,text,text)'; begin
 assert not has_function_privilege('authenticated',f,'execute');
 assert not has_function_privilege('anon',f,'execute');
 assert has_function_privilege('service_role',f,'execute');
 assert not has_table_privilege('authenticated','rentview_private.billing_reconciliation_audit','SELECT,INSERT,UPDATE,DELETE');
 assert not has_table_privilege('anon','rentview_private.billing_reconciliation_audit','SELECT,INSERT,UPDATE,DELETE');
end $$;
rollback;
