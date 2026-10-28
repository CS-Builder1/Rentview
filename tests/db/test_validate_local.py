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

    def fixture_reports(self):
        plan = ["baseline", "draft", "legacy", "identity", "rls", "regression"]
        report = {
            "draft_sha256": "draft-hash", "hosted_changes": False,
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
            def sql(self, statement):
                statements.append(statement)
                if statement == fresh_guard:
                    return "true"
                if statement == preflight:
                    return "\n".join(invariant + "|1" for invariant in (
                        "units.property_id ownership", "expenses.property_id ownership", "tenant_invites.lease_id ownership",
                        "maintenance_requests.lease_id ownership", "maintenance_requests.unit_id ownership", "maintenance_requests.property_id ownership",
                    ))
                return "source-only fake execution; no SQL was sent"

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
            self.assertEqual(len(report["stages"]), 20)
            legacy_position = statements.index((DIRECTORY / "legacy-check.sql").read_text())
            identity_position = statements.index(identity.read_text())
            regression_position = statements.index((DIRECTORY / "rls-performance.sql").read_text())
            self.assertLess(legacy_position, identity_position)
            self.assertLess(identity_position, regression_position)
            self.assertIn("tests/db/rls-performance.sql", report["validation_input_sha256"])


if __name__ == "__main__":
    unittest.main()
