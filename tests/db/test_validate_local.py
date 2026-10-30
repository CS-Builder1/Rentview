"""Source-only runner guard tests. Never constructs Docker or a database client."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace


DIRECTORY = Path(__file__).resolve().parent
sys.path.insert(0, str(DIRECTORY))
SPEC = importlib.util.spec_from_file_location("rentview_validate_local", DIRECTORY / "validate-local.py")
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class RunnerGuards(unittest.TestCase):
    def test_identity_source_requires_exactly_one_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            migrations = root / "supabase/migrations"
            migrations.mkdir(parents=True)
            with self.assertRaisesRegex(RuntimeError, "exactly one"):
                RUNNER.reviewed_identity_source(root)
            first = migrations / "20261028193614_optimize_identity_policies.sql"
            first.write_text("-- fixture")
            self.assertEqual(RUNNER.reviewed_identity_source(root), first)
            (migrations / "20261029193614_optimize_identity_policies.sql").write_text("-- ambiguous fixture")
            with self.assertRaisesRegex(RuntimeError, "exactly one"):
                RUNNER.reviewed_identity_source(root)

    def test_followup_sources_require_exactly_one_each_and_reviewed_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            migrations = root / "supabase/migrations"
            migrations.mkdir(parents=True)
            with self.assertRaisesRegex(RuntimeError, "exactly one"):
                RUNNER.reviewed_followup_sources(root)
            expected = [migrations / name for name in (
                "20261030110348_repair_review_operations.sql",
                "20261030110358_reconcile_billing_safely.sql",
                "20261030110404_notification_terminal_delivery.sql",
                "20261030111719_identity_deletion_worker_claim.sql",
            )]
            for path in expected:
                path.write_text("-- fixture")
            self.assertEqual(RUNNER.reviewed_followup_sources(root), expected)
            duplicate = migrations / "20261031110348_repair_review_operations.sql"
            duplicate.write_text("-- ambiguous")
            with self.assertRaisesRegex(RuntimeError, "exactly one"):
                RUNNER.reviewed_followup_sources(root)
            duplicate.unlink()
            expected[0].rename(migrations / "20261031110348_repair_review_operations.sql")
            with self.assertRaisesRegex(RuntimeError, "order changed"):
                RUNNER.reviewed_followup_sources(root)

    def test_unapproved_container_rejected_before_client_discovery(self):
        with patch("concurrency.shutil.which", side_effect=AssertionError("No client discovery allowed")) as discover:
            with self.assertRaisesRegex(RuntimeError, "unapproved database container"):
                RUNNER.LocalDB("production-or-arbitrary-container")
            discover.assert_not_called()

    def test_expected_failure_requires_error_state_and_specific_gate_message(self):
        database = RUNNER.LocalDB.__new__(RUNNER.LocalDB)
        database.container = "supabase_db_rentview-review-followup"
        database.prefix = ["source-only-fake-docker"]
        database.env = {}
        expected = "Legacy billing reconciliation required before migration"
        for result in (
            SimpleNamespace(returncode=0, stdout="", stderr="23514 " + expected),
            SimpleNamespace(returncode=1, stdout="", stderr="42501 " + expected),
            SimpleNamespace(returncode=1, stdout="", stderr="23514 unrelated constraint failure"),
        ):
            with patch("concurrency.subprocess.run", return_value=result):
                with self.assertRaisesRegex(AssertionError, "Expected SQLSTATE 23514"):
                    database.sql("source-only fake SQL", expected_state="23514", expected_message=expected)
        result = SimpleNamespace(returncode=1, stdout="", stderr="23514 " + expected)
        with patch("concurrency.subprocess.run", return_value=result):
            self.assertEqual(database.sql("source-only fake SQL", expected_state="23514", expected_message=expected), "")

    def test_storage_owner_method_keeps_exact_container_socket_and_fixed_role(self):
        database = RUNNER.LocalDB.__new__(RUNNER.LocalDB)
        database.container = "supabase_db_rentview-review-followup"
        database.prefix = ["source-only-fake-docker", "--host=unix:///var/run/docker.sock"]
        database.env = {}
        result = SimpleNamespace(returncode=0, stdout="source-only", stderr="")
        with patch("concurrency.subprocess.run", return_value=result) as execute:
            self.assertEqual(database.sql_as_storage_owner("source-only SQL"), "source-only")
            command = execute.call_args.args[0]
            self.assertEqual(command[1], "--host=unix:///var/run/docker.sock")
            self.assertEqual(command[4], "supabase_db_rentview-review-followup")
            self.assertEqual(command[command.index("-U") + 1], "supabase_storage_admin")
            self.assertEqual(command[command.index("-d") + 1], "postgres")
            self.assertNotIn("SET ROLE", execute.call_args.kwargs["input"].upper())

    def fixture_reports(self):
        plan = ["baseline", "draft", "legacy", "identity", "rls", "regression"]
        report = {
            "draft_sha256": "draft-hash", "hosted_changes": False,
            "runner_contract_version": 2, "container": "supabase_db_rentview-review-followup",
            "followup_migrations": [{"path": "operations.sql", "sha256": "operations-hash"}],
            "identity_migration_path": "migration.sql", "identity_migration_sha256": "identity-hash",
            "validation_stage_plan": plan,
            "validation_input_sha256": {"fixture.sql": "fixture-hash"},
        }
        previous = copy.deepcopy(report)
        previous["stages"] = [{"name": name, "status": "passed"} for name in plan[:4]]
        return report, previous, plan, plan[:2]

    def test_current_ordered_resume_inherits_only_passed_prefix(self):
        report, previous, plan, setup = self.fixture_reports()
        previous["stages"].append({"name": "rls", "status": "failed"})
        self.assertEqual(RUNNER.resume_records(previous, report, plan, setup), plan[:4])

    def test_old_report_cannot_inherit_new_stages(self):
        report, previous, plan, setup = self.fixture_reports()
        previous.pop("identity_migration_sha256")
        with self.assertRaisesRegex(ValueError, "older reports cannot inherit"):
            RUNNER.resume_records(previous, report, plan, setup)

    def test_changed_stage_plan_or_input_hash_rejected(self):
        for field, changed in (
            ("validation_stage_plan", ["baseline", "draft", "legacy", "regression"]),
            ("validation_input_sha256", {"fixture.sql": "changed-fixture"}),
            ("identity_migration_sha256", "changed-migration"),
            ("followup_migrations", [{"path": "operations.sql", "sha256": "changed"}]),
            ("runner_contract_version", 1),
            ("container", "supabase_db_rentview-local-test"),
        ):
            with self.subTest(field=field):
                report, previous, plan, setup = self.fixture_reports()
                previous[field] = changed
                with self.assertRaises(ValueError):
                    RUNNER.resume_records(previous, report, plan, setup)

    def test_wrong_stage_order_or_incomplete_setup_rejected(self):
        report, previous, plan, setup = self.fixture_reports()
        previous["stages"][2], previous["stages"][3] = previous["stages"][3], previous["stages"][2]
        with self.assertRaisesRegex(ValueError, "expected ordered"):
            RUNNER.resume_records(previous, report, plan, setup)
        previous["stages"] = [{"name": "baseline", "status": "passed"}]
        with self.assertRaisesRegex(ValueError, "requires all baseline"):
            RUNNER.resume_records(previous, report, plan, setup)

    def test_old_resume_rejected_before_any_database_construction(self):
        scratch = Path("/workspace/scratch")
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="rentview-runner-guard-", dir=scratch) as directory:
            root = DIRECTORY.parents[1]
            draft = RUNNER.reviewed_sql_source(root)
            previous = Path(directory) / "old-results.json"
            previous.write_text(json.dumps({
                "draft_sha256": RUNNER.hashlib.sha256(draft.read_bytes()).hexdigest(),
                "hosted_changes": False, "stages": [],
            }))
            arguments = ["validate-local.py", "--allow-disposable-local", "--output", str(Path(directory) / "new"), "--resume-from", str(previous)]
            error_output = io.StringIO()
            with patch.object(sys, "argv", arguments), patch.object(RUNNER, "LocalDB", side_effect=AssertionError("Database must never be constructed")) as database:
                with contextlib.redirect_stderr(error_output), self.assertRaises(SystemExit) as stopped:
                    RUNNER.main()
                self.assertEqual(stopped.exception.code, 2)
                database.assert_not_called()
            self.assertIn("older reports cannot inherit the new stages", error_output.getvalue())

    def test_fresh_orchestration_preserves_legacy_before_identity_and_new_tests(self):
        root = DIRECTORY.parents[1]
        statements = []
        fresh_guard = "select (to_regclass('public.properties') is null)::text;"
        preflight = (DIRECTORY / "preflight.sql").read_text()

        class SourceOnlyDatabase:
            def __init__(self, container):
                self.container = container
            def sql(self, statement, expected_state=None, expected_message=None):
                statements.append((statement, expected_state, expected_message))
                if statement == fresh_guard:
                    return "true"
                if statement == preflight:
                    return "\n".join(invariant + "|1" for invariant in (
                        "units.property_id ownership", "expenses.property_id ownership", "tenant_invites.lease_id ownership",
                        "maintenance_requests.lease_id ownership", "maintenance_requests.unit_id ownership", "maintenance_requests.property_id ownership",
                    ))
                return "source-only fake execution; no SQL was sent"
            def sql_as_storage_owner(self, statement, expected_state=None, expected_message=None):
                statements.append((statement, expected_state or "supabase_storage_admin", expected_message))
                return "source-only fake owner execution; no SQL was sent"

        with tempfile.TemporaryDirectory(prefix="rentview-runner-order-", dir="/workspace/scratch") as directory:
            output = Path(directory) / "results"
            arguments = ["validate-local.py", "--allow-disposable-local", "--output", str(output)]
            with patch.object(sys, "argv", arguments), patch.object(RUNNER, "LocalDB", SourceOnlyDatabase), patch.object(RUNNER, "run_concurrency", return_value=["source-only fake race"]):
                with contextlib.redirect_stdout(io.StringIO()):
                    RUNNER.main()
            report = json.loads((output / "results.json").read_text())
            identity = RUNNER.reviewed_identity_source(root)
            self.assertEqual(report["identity_migration_path"], str(identity.relative_to(root)))
            self.assertEqual(report["identity_migration_sha256"], RUNNER.hashlib.sha256(identity.read_bytes()).hexdigest())
            self.assertEqual([stage["name"] for stage in report["stages"]], report["validation_stage_plan"])
            self.assertEqual(len(report["stages"]), 34)
            self.assertEqual(report["container"], "supabase_db_rentview-review-followup")
            self.assertEqual(report["runner_contract_version"], 2)
            legacy_position = statements.index(((DIRECTORY / "legacy-check.sql").read_text(), None, None))
            identity_position = statements.index((identity.read_text(), None, None))
            regression_position = statements.index(((DIRECTORY / "rls-performance.sql").read_text(), None, None))
            self.assertLess(legacy_position, identity_position)
            self.assertLess(identity_position, regression_position)
            self.assertIn("tests/db/rls-performance.sql", report["validation_input_sha256"])
            followups = RUNNER.reviewed_followup_sources(root)
            positions = [statements.index((path.read_text(), None, None)) for path in followups]
            self.assertEqual(positions, sorted(positions))
            quota = root / "supabase/privileged/index_storage_owner_quota.sql"
            wrong_owner_position = statements.index((quota.read_text(), "42501", "Run only as the actual Storage table owner; no changes were made"))
            owner_position = statements.index((quota.read_text(), "supabase_storage_admin", None))
            missing_index_position = statements.index((followups[0].read_text(), "55000", "Storage quota index owner maintenance required before review operations migration"))
            self.assertLess(identity_position, missing_index_position)
            self.assertLess(missing_index_position, wrong_owner_position)
            self.assertLess(wrong_owner_position, owner_position)
            self.assertLess(owner_position, positions[0])
            self.assertLess(positions[-1], regression_position)
            draft_statement = "begin;\n" + RUNNER.reviewed_sql_source(root).read_text() + "\ncommit;"
            rejected_position = statements.index((draft_statement, "23514", "Legacy billing reconciliation required before migration"))
            bootstrap = root / "supabase/privileged/prepare_legacy_billing_reconciliation.sql"
            bootstrap_position = statements.index((bootstrap.read_text(), None, None))
            stage_position = statements.index(((DIRECTORY / "legacy-billing-stage.sql").read_text(), None, None))
            applied_position = statements.index((draft_statement, None, None))
            self.assertLess(rejected_position, bootstrap_position)
            self.assertLess(bootstrap_position, stage_position)
            self.assertLess(stage_position, applied_position)
            self.assertLess(applied_position, legacy_position)
            for path in followups + [bootstrap, quota, DIRECTORY / "review-operations.sql", DIRECTORY / "billing-reconciliation.sql", DIRECTORY / "notification-delivery.sql", DIRECTORY / "deletion-worker.sql"]:
                self.assertEqual(report["validation_input_sha256"][str(path.relative_to(root))], RUNNER.hashlib.sha256(path.read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
