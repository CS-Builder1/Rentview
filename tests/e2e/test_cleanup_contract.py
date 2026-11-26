"""Fixture-only cleanup contract checks: no services, browser or credentials."""
import unittest

from local_e2e import LocalAPI


UID = "11111111-1111-4111-8111-111111111111"
EMAIL = "rentview-cleanup-fixture@example.test"


class CleanupContractTests(unittest.TestCase):
    def fixture(self, *, claim="claimed", failure=None, repeated=False):
        api = LocalAPI({"url": "http://127.0.0.1:54321", "anon": "fixture-anon", "service": "fixture-service"}, [])
        api.register_synthetic_user(UID, EMAIL)
        calls, listings = [], []

        def request(method, path, **kwargs):
            body = kwargs.get("body")
            calls.append((method, path, body))
            self.assertTrue(kwargs.get("admin"))
            if failure is not None:
                failed = failure(method, path, body)
                if failed is not None:
                    return failed
            if method == "GET":
                return 200, {"id": UID, "email": EMAIL}
            if path.endswith("/claim_identity_deletion_worker"):
                return 200, claim
            if path.endswith("/owned_storage_paths"):
                listings.append(body)
                if repeated:
                    return 200, [{"bucket_id": "attachments", "name": f"{UID}/file-{index}.png"} for index in range(100)]
                return 200, ([{"bucket_id": "attachments", "name": f"{UID}/photo.png"}, {"bucket_id": "fixture-other-bucket", "name": "nested/document.txt"}] if len(listings) == 1 else [])
            if any(path.endswith("/" + name) for name in ["begin_identity_deletion_step", "finish_identity_deletion_step", "mark_identity_deletion_uncertain", "release_identity_deletion_worker"]):
                return 200, True
            return 200, None

        api.request = request
        return api, calls

    def test_unregistered_identity_is_rejected_before_any_request(self):
        api, calls = self.fixture()
        result = api.cleanup_synthetic_user("22222222-2222-4222-8222-222222222222")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(calls, [])

    def test_nonfixture_registration_is_rejected_before_requests(self):
        api, calls = self.fixture()
        for uid, email in [(UID, "someone@example.test"), ("../user", EMAIL), (UID, "rentview-test@example.com")]:
            with self.assertRaises(ValueError):
                api.register_synthetic_user(uid, email)
        self.assertEqual(calls, [])

    def test_mismatched_stored_email_cannot_start_deletion(self):
        api, calls = self.fixture(failure=lambda method, *_: (200, {"id": UID, "email": "other@example.test"}) if method == "GET" else None)
        result = api.cleanup_synthetic_user(UID)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(len(calls), 1)

    def test_success_removes_all_owned_buckets_in_claimed_order(self):
        api, calls = self.fixture()
        result = api.cleanup_synthetic_user(UID)
        self.assertEqual(result["status"], "deleted")
        self.assertEqual(result["removed_objects"], 2)
        self.assertEqual(result["errors"], [])
        names = [path.rsplit("/", 1)[-1] for _, path, _ in calls]
        self.assertEqual(names, [
            UID, "prepare_identity_deletion", "claim_identity_deletion_worker", "owned_storage_paths",
            "begin_identity_deletion_step", "attachments", "finish_identity_deletion_step", "forget_deleted_uploads",
            "begin_identity_deletion_step", "fixture-other-bucket", "finish_identity_deletion_step",
            "owned_storage_paths", "prepare_identity_deletion", "begin_identity_deletion_step", UID,
        ])
        claim = next(body for _, path, body in calls if path.endswith("/claim_identity_deletion_worker"))
        for _, path, body in calls:
            if path.rsplit("/", 1)[-1] in {"owned_storage_paths", "forget_deleted_uploads", "begin_identity_deletion_step", "finish_identity_deletion_step"}:
                self.assertEqual(body["p_owner_id"], UID)
                self.assertEqual(body["p_claim_token"], claim["p_claim_token"])
        self.assertNotIn(UID, api.synthetic_users)

    def test_existing_running_or_uncertain_worker_is_never_overtaken(self):
        for state in ["running", "needs_review"]:
            with self.subTest(state=state):
                api, calls = self.fixture(claim=state)
                result = api.cleanup_synthetic_user(UID)
                self.assertEqual(result["status"], "blocked")
                self.assertEqual(len(calls), 3)
                self.assertTrue(all(method != "DELETE" for method, *_ in calls))

    def test_storage_timeout_marks_uncertain_without_auth_delete_or_release(self):
        def failure(method, path, _body):
            if method == "DELETE" and path.startswith("/storage/"):
                raise TimeoutError("Unknown storage outcome")
        api, calls = self.fixture(failure=failure)
        result = api.cleanup_synthetic_user(UID)
        self.assertEqual(result["status"], "needs_review")
        self.assertTrue(calls[-1][1].endswith("/mark_identity_deletion_uncertain"))
        self.assertFalse(any(path.endswith("/release_identity_deletion_worker") or path.endswith("/finish_identity_deletion_step") or method == "DELETE" and path.startswith("/auth/") for method, path, _ in calls))

    def test_lost_finish_acknowledgement_stops_before_forget_or_next_delete(self):
        api, calls = self.fixture(failure=lambda _method, path, _body: (500, {"message": "Uncertain completion"}) if path.endswith("/finish_identity_deletion_step") else None)
        result = api.cleanup_synthetic_user(UID)
        self.assertEqual(result["status"], "needs_review")
        self.assertEqual(sum(method == "DELETE" for method, *_ in calls), 1)
        self.assertFalse(any(path.endswith("/forget_deleted_uploads") for _, path, _ in calls))

    def test_non_destructive_read_failure_releases_only_its_claim(self):
        api, calls = self.fixture(failure=lambda _method, path, _body: (500, {"message": "Read failed"}) if path.endswith("/owned_storage_paths") else None)
        result = api.cleanup_synthetic_user(UID)
        self.assertEqual(result["status"], "failed")
        self.assertTrue(calls[-1][1].endswith("/release_identity_deletion_worker"))
        claim = next(body for _, path, body in calls if path.endswith("/claim_identity_deletion_worker"))
        self.assertEqual(calls[-1][2], claim)
        self.assertFalse(any(method == "DELETE" for method, *_ in calls))

    def test_storage_bound_stops_before_auth_deletion(self):
        api, calls = self.fixture(repeated=True)
        result = api.cleanup_synthetic_user(UID)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["removed_objects"], 2000)
        self.assertIn("2,000-object bound", result["errors"][0]["message"])
        self.assertTrue(calls[-1][1].endswith("/release_identity_deletion_worker"))
        self.assertFalse(any(method == "DELETE" and path.startswith("/auth/") for method, path, _ in calls))


if __name__ == "__main__":
    unittest.main()
