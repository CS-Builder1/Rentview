"""Validate the reviewed migrations once against the fresh local Docker DB.

Never targets a hosted database. Refuses an existing RentView schema. Logs use
synthetic fixtures only and are written privately under /workspace/scratch.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path

from concurrency import ALLOWED_CONTAINERS, FOLLOWUP_CONTAINER, LocalDB, run as run_concurrency


def reviewed_sql_source(root):
    """Prefer the CLI-generated canonical migration once packaging is complete."""
    candidates = list((root / "supabase/migrations").glob("*_trust_and_operations.sql"))
    pending = root / "supabase/pending/trust_and_operations.sql"
    if len(candidates) > 1:
        raise RuntimeError("Ambiguous hardening migrations; no database contacted")
    if not candidates:
        if not pending.is_file():
            raise RuntimeError("Reviewed hardening SQL is unavailable; no database contacted")
        return pending
    canonical = candidates[0]
    if pending.is_file():
        marker = "create schema if not exists rentview_private;"
        canonical_text, pending_text = canonical.read_text(), pending.read_text()
        if marker not in canonical_text or marker not in pending_text or canonical_text[canonical_text.index(marker):] != pending_text[pending_text.index(marker):]:
            raise RuntimeError("Canonical migration and pending SQL disagree; no database contacted")
    return canonical


def reviewed_identity_source(root):
    """The packaged release includes exactly one reviewed additive migration."""
    candidates = list((root / "supabase/migrations").glob("*_optimize_identity_policies.sql"))
    if len(candidates) != 1:
        raise RuntimeError("Expected exactly one reviewed identity-policy migration; no database contacted")
    return candidates[0]


def reviewed_followup_sources(root):
    """Every review correction is explicit, ordered and independently hash-bound."""
    sources = []
    for suffix in ("repair_review_operations", "reconcile_billing_safely", "notification_terminal_delivery", "identity_deletion_worker_claim"):
        candidates = list((root / "supabase/migrations").glob(f"*_{suffix}.sql"))
        if len(candidates) != 1:
            raise RuntimeError(f"Expected exactly one reviewed {suffix} migration; no database contacted")
        sources.append(candidates[0])
    if sources != sorted(sources):
        raise RuntimeError("Reviewed follow-up migration order changed; no database contacted")
    return sources


def resume_records(previous, report, expected_stages, setup_stages):
    """Reject stale evidence before constructing any database connection."""
    if previous.get("draft_sha256") != report["draft_sha256"] or previous.get("hosted_changes") is not False:
        raise ValueError("Resume report does not match this unchanged locally applied draft")
    if previous.get("identity_migration_path") != report["identity_migration_path"] or previous.get("identity_migration_sha256") != report["identity_migration_sha256"]:
        raise ValueError("Resume report does not match the reviewed identity migration; older reports cannot inherit the new stages")
    if previous.get("runner_contract_version") != report["runner_contract_version"]:
        raise ValueError("Older reports cannot inherit review-correction stages")
    if previous.get("container") != report["container"]:
        raise ValueError("Resume report targets another disposable container")
    if previous.get("followup_migrations") != report["followup_migrations"]:
        raise ValueError("Resume report does not match all reviewed follow-up migrations")
    if previous.get("validation_stage_plan") != expected_stages:
        raise ValueError("Resume report does not have the current complete ordered stage plan")
    if previous.get("validation_input_sha256") != report["validation_input_sha256"]:
        raise ValueError("Resume report does not match all unchanged validation inputs")
    records = previous.get("stages", [])
    if not isinstance(records, list) or not all(isinstance(record, dict) for record in records):
        raise ValueError("Resume report has invalid validation stages")
    if [record.get("name") for record in records] != expected_stages[:len(records)]:
        raise ValueError("Resume report does not have the expected ordered validation stages")
    passed = []
    for record in records:
        if record.get("status") != "passed":
            break
        passed.append(record["name"])
    if not set(setup_stages).issubset(passed):
        raise ValueError("Resume requires all baseline, seed, preflight and draft-application stages to have passed")
    return passed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-disposable-local", action="store_true")
    parser.add_argument("--container", choices=sorted(ALLOWED_CONTAINERS), default=FOLLOWUP_CONTAINER, help="Exact pre-approved disposable Docker container; no URLs accepted")
    parser.add_argument("--output", default="/workspace/scratch/rentview-local-db")
    parser.add_argument("--resume-from", help="Prior private results.json with matching migrations, inputs and complete stage plan; skip only its passed stages")
    arguments = parser.parse_args()
    if not arguments.allow_disposable_local:
        parser.error("Explicit --allow-disposable-local is required; no database contacted")
    output = Path(arguments.output)
    if not output.is_absolute() or not output.resolve().is_relative_to(Path("/workspace/scratch")) or output.is_symlink():
        parser.error("Output must be a task-local directory under /workspace/scratch")
    if (output / "results.json").exists():
        parser.error("Results already exist; choose a new output directory to preserve prior evidence")
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(output, 0o700)
    root = Path(__file__).resolve().parents[2]
    draft = reviewed_sql_source(root)
    identity_migration = reviewed_identity_source(root)
    followups = reviewed_followup_sources(root)
    report = {"status": "running", "runner_contract_version": 2, "container": arguments.container,
              "migration_application_method": "transactional SQL replay; does not populate Supabase CLI history",
              "followup_migrations": [{"path": str(p.relative_to(root)), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in followups], "target": "task-specific disposable Docker PostgreSQL", "hosted_changes": False,
              "draft_path": str(draft.relative_to(root)), "draft_sha256": hashlib.sha256(draft.read_bytes()).hexdigest(),
              "identity_migration_path": str(identity_migration.relative_to(root)),
              "identity_migration_sha256": hashlib.sha256(identity_migration.read_bytes()).hexdigest(), "stages": []}
    migrations = sorted((root / "supabase/migrations").glob("000[1-9]_*.sql"))
    if len(migrations) != 9:
        raise RuntimeError("Expected the reviewed baseline0001..0009; no application writes sent")
    setup_stages = [p.name for p in migrations] + [
        "seed deliberate legacy inconsistencies", "legacy preflight detects inconsistent relationships",
        "legacy billing gate aborts before mutations and preserves catalog and subscription snapshots",
        "create operator-only legacy billing evidence ledger",
        "stage explicit synthetic legacy billing decisions", "apply pending draft in one transaction"]
    identity_stage = "apply reviewed identity-policy migration in one transaction"
    storage_maintenance_stages = [
        "missing quota index and wrong-owner maintenance abort before mutation",
        "apply reviewed quota index as actual local Storage owner"]
    followup_stages = ["apply reviewed operations correction in one transaction",
                       "apply reviewed billing reconciliation correction in one transaction",
                       "apply reviewed notification correction in one transaction",
                       "apply reviewed exclusive deletion worker claim in one transaction"]
    regression_stages = ["legacy preservation, denial, cleanup and full constraint validation", identity_stage] + storage_maintenance_stages + followup_stages + [
        "identity predicate equivalence, actor boundaries and measured InitPlan regressions",
        "ownership, invitation, operations, fractional stock and deletion regressions",
        "billing, outbox, reminder and deletion-failure regressions", "finite numeric API-style and RPC regressions",
        "tenant projection isolation and redaction regressions", "relationship deletion cascade and clearing regressions",
        "local calendars, recurrence, reopening, upload quota and deletion metadata regressions",
        "trusted billing reconciliation, same-second ambiguity and rollback regressions",
        "terminal notification, exhausted retry and claim isolation regressions",
        "exclusive identity deletion worker, uncertain calls and claim isolation regressions", "concurrent invoice and completion integrity"]
    expected_stages = setup_stages + regression_stages
    report["validation_stage_plan"] = expected_stages
    # A matching migration alone cannot justify inheriting a result from older
    # test logic. Hash every runner/fixture dependency used by these stages.
    inputs = migrations + [draft, identity_migration] + followups + [root / "supabase/privileged/prepare_legacy_billing_reconciliation.sql", root / "supabase/privileged/index_storage_owner_quota.sql"] + [root / "tests/db" / name for name in (
        "validate-local.py", "concurrency.py", "legacy-seed.sql", "preflight.sql", "legacy-check.sql",
        "rls-performance.sql", "rls-performance-manifest.json", "trust.sql", "backend-services.sql", "numerics.sql", "tenant-projection.sql",
        "rls-snapshot.sql", "legacy-billing-stage.sql", "relationship-deletion.sql", "review-operations.sql", "billing-reconciliation.sql", "notification-delivery.sql", "deletion-worker.sql",
    )]
    report["validation_input_sha256"] = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs}
    passed = set()
    if arguments.resume_from:
        previous_path = Path(arguments.resume_from)
        if not previous_path.is_absolute() or not previous_path.resolve().is_relative_to(Path("/workspace/scratch")) or previous_path.is_symlink():
            parser.error("Resume report must be a task-local regular file under /workspace/scratch")
        previous = json.loads(previous_path.read_text())
        try:
            inherited = resume_records(previous, report, expected_stages, setup_stages)
        except ValueError as error:
            parser.error(str(error))
        for name in inherited:
            passed.add(name)
            report["stages"].append({"name": name, "status": "passed", "inherited_from": str(previous_path)})
        report["resumed_from"] = str(previous_path)

    def save():
        path = output / "results.json"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(report, stream, indent=2)

    def stage(name, operation):
        if name in passed:
            return
        record = {"name": name, "status": "running"}
        report["stages"].append(record)
        save()
        try:
            value = operation()
            descriptor = os.open(output / f"{len(report['stages']):02d}.log", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, "w") as stream:
                stream.write(value if isinstance(value, str) else json.dumps(value, indent=2))
            record["status"] = "passed"
            print("PASS: " + name, flush=True)
        except Exception as error:
            record["status"] = "failed"
            record["error"] = str(error)
            report["status"] = "failed"
            save()
            raise
        save()

    db = LocalDB(arguments.container)
    if arguments.resume_from:
        completion_signature = "public.complete_work_order(uuid,numeric,text,text,boolean,text)" if followup_stages[0] in passed else "public.complete_work_order(uuid,numeric,text,text,boolean)"
        if db.sql("select (to_regclass('public.account_deletion_requests') is not null and to_regprocedure('" + completion_signature + "') is not null)::text;") != "true":
            raise RuntimeError("Resume target does not contain the applied draft; no application writes sent")
        if identity_stage in passed:
            # Require actual optimized predicates on the resumed target as well
            # as a matching report. Do not assume another local DB's evidence
            # proves this container has advanced past the additive migration.
            manifest = json.loads((root / "tests/db/rls-performance-manifest.json").read_text())
            if len(manifest) != 68 or len({(item["table"], item["policy"]) for item in manifest}) != 68:
                raise RuntimeError("Invalid reviewed identity-policy manifest; no application writes sent")
            checks = []
            for item in manifest:
                # Manifest entries are checked-in identifiers, never CLI input.
                if not all(isinstance(item[key], str) and item[key].replace("_", "").isalnum() for key in ("table", "policy", "column", "command")):
                    raise RuntimeError("Invalid reviewed identity-policy identifier; no application writes sent")
                using = f"({item['column']}=(selectauth.uid()asuid))" if item["command"] in ("r", "w", "d") else None
                check = f"({item['column']}=(selectauth.uid()asuid))" if item["command"] in ("a", "w") else None
                literal = lambda value: "null" if value is None else "'" + value + "'"
                checks.append(f"('{item['table']}','{item['policy']}','{item['command']}',{literal(using)},{literal(check)})")
            verified = db.sql("select (count(p.oid)=68 and bool_and(p.polcmd::text=e.command "
                              "and regexp_replace(lower(pg_get_expr(p.polqual,p.polrelid)),'\\s','','g') is not distinct from e.using_expression "
                              "and regexp_replace(lower(pg_get_expr(p.polwithcheck,p.polrelid)),'\\s','','g') is not distinct from e.check_expression))::text "
                              "from (values " + ",".join(checks) + ") e(table_name,policy_name,command,using_expression,check_expression) "
                              "left join pg_policy p on p.polrelid=to_regclass(format('public.%I',e.table_name)) and p.polname=e.policy_name;")
            if verified != "true":
                raise RuntimeError("Resume target does not contain all 68 optimized identity policies; no application writes sent")
        readiness = [
            (followup_stages[0], "to_regprocedure('rentview_private.calendar_date_at(timestamptz,text)') is not null and to_regclass('rentview_private.identity_storage_cleanup') is not null and (select count(*)>20 and bool_and(position('SELECT' in pg_get_expr(polqual,polrelid))>0 and not polpermissive) from pg_policy where polname='current_account_required')"),
            (followup_stages[1], "to_regclass('rentview_private.billing_reconciliation_audit') is not null and to_regprocedure('public.billing_reconciliation_pending()') is not null"),
            (followup_stages[2], "to_regprocedure('public.finish_notification(uuid,uuid,boolean,jsonb,text,boolean)') is not null and to_regprocedure('public.finish_notification(uuid,uuid,boolean,jsonb,text)') is null"),
            (followup_stages[3], "to_regclass('rentview_private.identity_deletion_workers') is not null and to_regprocedure('public.owned_storage_paths(uuid,uuid,integer)') is not null and not has_function_privilege('service_role','public.owned_storage_paths(uuid,integer)','execute')"),
        ]
        for applied_stage, predicate in readiness:
            if applied_stage in passed and db.sql("select (" + predicate + ")::text;") != "true":
                raise RuntimeError("Resume target does not contain the recorded correction: " + applied_stage + "; no application writes sent")
    elif db.sql("select (to_regclass('public.properties') is null)::text;") != "true":
        raise RuntimeError("Refusing to initialize an existing RentView schema; no application writes sent")
    for migration in migrations:
        stage(migration.name, lambda migration=migration: db.sql("begin;\n" + migration.read_text() + "\ncommit;"))
    stage("seed deliberate legacy inconsistencies", lambda: db.sql((root / "tests/db/legacy-seed.sql").read_text()))

    def preflight():
        result = db.sql((root / "tests/db/preflight.sql").read_text())
        counts = dict(line.rsplit("|", 1) for line in result.splitlines() if "|" in line)
        for invariant in ("units.property_id ownership", "expenses.property_id ownership", "tenant_invites.lease_id ownership",
                          "maintenance_requests.lease_id ownership", "maintenance_requests.unit_id ownership", "maintenance_requests.property_id ownership"):
            if counts.get(invariant) != "1":
                raise AssertionError("Preflight missed deliberate legacy inconsistency: " + invariant)
        return result

    stage("legacy preflight detects inconsistent relationships", preflight)
    def rejected_legacy_billing_gate():
        catalog_sql = (root / "tests/db/rls-snapshot.sql").read_text()
        subscription_sql = "select coalesce(jsonb_agg(to_jsonb(s) order by owner_id),'[]'::jsonb) from public.subscriptions s;"
        before_catalog, before_subscriptions = db.sql(catalog_sql), db.sql(subscription_sql)
        db.sql("begin;\n" + draft.read_text() + "\ncommit;", expected_state="23514",
               expected_message="Legacy billing reconciliation required before migration")
        after_catalog, after_subscriptions = db.sql(catalog_sql), db.sql(subscription_sql)
        if before_catalog != after_catalog or before_subscriptions != after_subscriptions:
            raise AssertionError("Rejected legacy billing migration changed catalog or subscription rows")
        return {"expected_state": "23514", "exact_gate_message_matched": True,
                "catalog_unchanged_sha256": hashlib.sha256(before_catalog.encode()).hexdigest(),
                "subscriptions_unchanged_sha256": hashlib.sha256(before_subscriptions.encode()).hexdigest()}

    stage("legacy billing gate aborts before mutations and preserves catalog and subscription snapshots", rejected_legacy_billing_gate)
    stage("create operator-only legacy billing evidence ledger", lambda: db.sql((root / "supabase/privileged/prepare_legacy_billing_reconciliation.sql").read_text()))
    stage("stage explicit synthetic legacy billing decisions", lambda: db.sql((root / "tests/db/legacy-billing-stage.sql").read_text()))
    stage("apply pending draft in one transaction", lambda: db.sql("begin;\n" + draft.read_text() + "\ncommit;"))
    stage("legacy preservation, denial, cleanup and full constraint validation", lambda: db.sql((root / "tests/db/legacy-check.sql").read_text()))
    # The generated additive file contains its own BEGIN/COMMIT. Legacy rows
    # must pass the original denial/reconciliation checks before it is applied.
    stage(identity_stage, lambda: db.sql(identity_migration.read_text()))
    def reject_unprivileged_quota_maintenance():
        catalog_sql = (root / "tests/db/rls-snapshot.sql").read_text()
        before = db.sql(catalog_sql)
        db.sql(followups[0].read_text(), expected_state="55000",
               expected_message="Storage quota index owner maintenance required before review operations migration")
        after_missing = db.sql(catalog_sql)
        db.sql((root / "supabase/privileged/index_storage_owner_quota.sql").read_text(), expected_state="42501",
               expected_message="Run only as the actual Storage table owner; no changes were made")
        after_owner = db.sql(catalog_sql)
        # An existing same-named index with another definition must fail closed,
        # not be silently accepted by CREATE INDEX IF NOT EXISTS.
        owner_script = (root / "supabase/privileged/index_storage_owner_quota.sql").read_text()
        db.sql_as_storage_owner("begin;\ncreate index rentview_storage_owner_created_idx on storage.objects(owner_id);\n" + owner_script,
                                expected_state="55000", expected_message="Existing Storage quota index does not match the reviewed definition")
        after_wrong_index = db.sql(catalog_sql)
        if before != after_missing or before != after_owner or before != after_wrong_index:
            raise AssertionError("Rejected quota prerequisite/owner maintenance changed the catalog")
        return {"missing_index_state": "55000", "wrong_owner_state": "42501", "wrong_index_state": "55000", "specific_messages_matched": True,
                "catalog_unchanged_sha256": hashlib.sha256(before.encode()).hexdigest()}

    stage(storage_maintenance_stages[0], reject_unprivileged_quota_maintenance)
    stage(storage_maintenance_stages[1], lambda: db.sql_as_storage_owner((root / "supabase/privileged/index_storage_owner_quota.sql").read_text()))
    for name, migration in zip(followup_stages, followups):
        stage(name, lambda migration=migration: db.sql(migration.read_text()))
    stage("identity predicate equivalence, actor boundaries and measured InitPlan regressions", lambda: db.sql((root / "tests/db/rls-performance.sql").read_text()))
    stage("ownership, invitation, operations, fractional stock and deletion regressions", lambda: db.sql((root / "tests/db/trust.sql").read_text()))
    stage("billing, outbox, reminder and deletion-failure regressions", lambda: db.sql((root / "tests/db/backend-services.sql").read_text()))
    stage("finite numeric API-style and RPC regressions", lambda: db.sql((root / "tests/db/numerics.sql").read_text()))
    stage("tenant projection isolation and redaction regressions", lambda: db.sql((root / "tests/db/tenant-projection.sql").read_text()))
    for name, filename in (
        ("relationship deletion cascade and clearing regressions", "relationship-deletion.sql"),
        ("local calendars, recurrence, reopening, upload quota and deletion metadata regressions", "review-operations.sql"),
        ("trusted billing reconciliation, same-second ambiguity and rollback regressions", "billing-reconciliation.sql"),
        ("terminal notification, exhausted retry and claim isolation regressions", "notification-delivery.sql"),
        ("exclusive identity deletion worker, uncertain calls and claim isolation regressions", "deletion-worker.sql"),
    ):
        stage(name, lambda filename=filename: db.sql((root / "tests/db" / filename).read_text()))
    stage("concurrent invoice and completion integrity", lambda: run_concurrency(db))
    report["status"] = "passed"
    report["coverage_limits"] = ["No hosted state or legacy customer data inspected", "No browser/API journey or Edge provider delivery in this runner", "Database advisors, pg_net owner maintenance and strict boundary checks run separately", "Storage quota index requires actual owner maintenance; no privilege changes are made", "SQL replay does not establish Supabase CLI migration-history records"]
    save()
    print(json.dumps({"status": "passed", "stages": len(report["stages"]), "report": str(output / "results.json")}))


if __name__ == "__main__":
    main()
