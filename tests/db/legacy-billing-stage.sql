-- Disposable local fixture ONLY, after the pre-mutation gate was shown to abort.
-- No provider calls: these explicit synthetic records emulate independently
-- verified operator evidence, not a customer metadata/email association.
begin;
insert into rentview_private.legacy_billing_reconciliation(
 owner_id,legacy_snapshot,decision,provider_evidence_ref,account_evidence_ref)
select owner_id,to_jsonb(s),'rejected','synthetic-review:no-provider-record','synthetic-audit:client-forged-row'
from public.subscriptions s where owner_id='90000000-0000-4000-8000-000000000001';
insert into rentview_private.legacy_billing_reconciliation(
 owner_id,legacy_snapshot,decision,provider,subscription_id,customer_id,plan,status,
 period_end,cancel_at_period_end,provider_updated_at,provider_evidence_ref,account_evidence_ref)
select owner_id,to_jsonb(s),'verified','paypal','synthetic-verified-provider-id','verified-customer','pro','active',
 now()+interval '1 month',false,now()-interval '1 hour','synthetic-provider:current-snapshot','synthetic-server:original-account-binding'
from public.subscriptions s where owner_id='90000000-0000-4000-8000-000000000004';
do $$ begin
 assert not has_table_privilege('authenticated','rentview_private.legacy_billing_reconciliation','SELECT,INSERT,UPDATE,DELETE');
 assert not has_table_privilege('anon','rentview_private.legacy_billing_reconciliation','SELECT,INSERT,UPDATE,DELETE');
 assert (select count(*)=2 from rentview_private.legacy_billing_reconciliation),'synthetic billing decisions missing';
end $$;
commit;
