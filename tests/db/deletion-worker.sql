-- Disposable synthetic metadata only; no Storage/Auth HTTP calls or files.
begin;
set local statement_timeout='15s';
create function pg_temp.ok(value boolean,message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'Assertion failed: %',message; end if; end $$;
create function pg_temp.denied(statement text,state text) returns void language plpgsql as $$
begin
 begin execute statement;
 exception when others then
  if sqlstate=state then return; end if;
  raise exception 'Expected %, got %: %',state,sqlstate,sqlerrm;
 end;
 raise exception 'Expected failure: %',statement;
end $$;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('ed100000-0000-4000-8000-000000000001','deletion-worker-owner@example.test',now(),'{}'),
 ('ed100000-0000-4000-8000-000000000002','deletion-worker-foreign@example.test',now(),'{}');
select public.prepare_identity_deletion('ed100000-0000-4000-8000-000000000001');
insert into storage.objects(bucket_id,name,owner_id) values
 ('attachments','requests/deletion-worker/owned.jpg','ed100000-0000-4000-8000-000000000001');

-- A single owner may have only one worker. Wrong and missing tokens never list
-- names or advance/release the other worker, including during an HTTP step.
set local role service_role;
select pg_temp.ok(public.claim_identity_deletion_worker('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000001')='claimed','first worker owns claim');
select pg_temp.ok(public.claim_identity_deletion_worker('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000002')='running','second worker cannot overtake');
select pg_temp.ok((select count(*)=1 from public.owned_storage_paths('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000001',100)),'claim owner lists owned path');
select pg_temp.denied($q$select * from public.owned_storage_paths('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000002',100)$q$,'42501');
select pg_temp.ok(not public.release_identity_deletion_worker('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000002'),'wrong token cannot release');
select pg_temp.ok(not public.begin_identity_deletion_step('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000002'),'wrong token cannot begin');
select pg_temp.ok(public.begin_identity_deletion_step('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000001'),'owner starts destructive step');
select pg_temp.ok(not public.release_identity_deletion_worker('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000001'),'inflight step cannot release');
select pg_temp.denied($q$select * from public.owned_storage_paths('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000001',100)$q$,'42501');
select pg_temp.ok(not public.finish_identity_deletion_step('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000002'),'wrong token cannot finish');
select pg_temp.ok(public.finish_identity_deletion_step('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000001'),'acknowledged step finishes');
select pg_temp.ok(public.release_identity_deletion_worker('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000001'),'acknowledged continuation releases');
select pg_temp.ok(public.claim_identity_deletion_worker('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000002')='claimed','normal continuation claims anew');
reset role;
-- Activity from the current worker renews the idle window.
update rentview_private.identity_deletion_workers set updated_at = now() - interval '11 minutes'
 where owner_id='ed100000-0000-4000-8000-000000000001';
set local role service_role;
select pg_temp.ok((select count(*)=1 from public.owned_storage_paths('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000002',100)),'worker can resume listing');
select pg_temp.ok(public.claim_identity_deletion_worker('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000003')='running','recently active worker stays exclusive');
reset role;
-- Simulate an interrupted worker between acknowledged steps. A new attempt
-- must list current ownership from scratch after taking the old idle claim.
update rentview_private.identity_deletion_workers set updated_at = now() - interval '11 minutes'
 where owner_id='ed100000-0000-4000-8000-000000000001';
set local storage.allow_delete_query='true';
delete from storage.objects where bucket_id='attachments' and name='requests/deletion-worker/owned.jpg';
insert into storage.objects(bucket_id,name,owner_id) values
 ('attachments','requests/deletion-worker/owned.jpg','ed100000-0000-4000-8000-000000000002');
set local role service_role;
select pg_temp.ok(public.claim_identity_deletion_worker('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000003')='claimed','idle worker may be replaced');
select pg_temp.ok(not public.begin_identity_deletion_step('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000002'),'stale token cannot dispatch');
select pg_temp.ok(not public.release_identity_deletion_worker('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000002'),'stale token cannot release replacement');
select pg_temp.denied($q$select * from public.owned_storage_paths('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000002',100)$q$,'42501');
select pg_temp.ok((select count(*)=0 from public.owned_storage_paths('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000003',100)),'foreign replacement not listed');
select pg_temp.ok(public.begin_identity_deletion_step('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000003'),'new worker begins step');
reset role;
update rentview_private.identity_deletion_workers set updated_at = now() - interval '1 day'
 where owner_id='ed100000-0000-4000-8000-000000000001';
set local role service_role;
select pg_temp.ok(public.claim_identity_deletion_worker('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000004')='running','clock never overtakes pending provider work');
select pg_temp.ok(public.mark_identity_deletion_uncertain('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000003'),'lost response requires review');
select pg_temp.ok(not public.finish_identity_deletion_step('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000003'),'uncertain work cannot resume blindly');
select pg_temp.ok(not public.release_identity_deletion_worker('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000003'),'uncertain work cannot auto-release');
reset role;
update rentview_private.identity_deletion_workers set updated_at = now() - interval '1 day'
 where owner_id='ed100000-0000-4000-8000-000000000001';
set local role service_role;
select pg_temp.ok(public.claim_identity_deletion_worker('ed100000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000004')='needs_review','clock never replaces a claim under review');
select pg_temp.denied($q$select * from public.owned_storage_paths('ed100000-0000-4000-8000-000000000001',100)$q$,'42501');
select pg_temp.denied($q$select public.forget_deleted_uploads('ed100000-0000-4000-8000-000000000001',array['requests/deletion-worker/owned.jpg'])$q$,'42501');
reset role;
select pg_temp.ok((select owner_id='ed100000-0000-4000-8000-000000000002' from storage.objects where bucket_id='attachments' and name='requests/deletion-worker/owned.jpg'),'replacement remains owned by other identity');
select pg_temp.ok(not has_table_privilege('service_role','rentview_private.identity_deletion_workers','delete'),'service RPC cannot bypass claim via table delete');
do $$ declare f record; begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
  ('claim_identity_deletion_worker','begin_identity_deletion_step','finish_identity_deletion_step','mark_identity_deletion_uncertain','release_identity_deletion_worker') loop
  assert not has_function_privilege('authenticated',f.oid,'execute'),'browser can control deletion workers';
  assert not has_function_privilege('anon',f.oid,'execute'),'anonymous can control deletion workers';
  assert has_function_privilege('service_role',f.oid,'execute'),'service cannot control deletion workers';
 end loop;
end $$;
rollback;
