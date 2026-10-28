"""Offline safety gates for the real local integration runner; no requests."""
import json
from pathlib import Path
import tempfile
import unittest
from local_e2e import LocalAPI, LocalRedirects, local_url, private_credentials
from urllib.request import Request


class LocalTargetTests(unittest.TestCase):
    def test_only_loopback_bases_are_accepted(self):
        for value in ["http://127.0.0.1:54321", "http://localhost:8081", "http://[::1]:54321"]:
            self.assertEqual(local_url(value, root=True), value)
        for value in ["https://hosted.supabase.co", "https://localhost.evil.test", "http://127.0.0.1.evil.test", "http://user:pass@localhost:54321", "http://localhost:54321?host=elsewhere", "http://localhost:54321/override", "file:///workspace/fixture"]:
            with self.assertRaises(ValueError):
                local_url(value, root=True)

    def test_credentials_require_owner_only_regular_file_and_local_api(self):
        with tempfile.TemporaryDirectory(prefix="rentview-e2e-target-") as temporary:
            root = Path(temporary)
            target = root / "target.json"
            target.write_text(json.dumps({"api_url": "http://127.0.0.1:54321", "anon_key": "fixture-anon", "service_role_key": "fixture-service"}))
            target.chmod(0o600)
            self.assertEqual(private_credentials(target)["url"], "http://127.0.0.1:54321")
            target.chmod(0o644)
            with self.assertRaises(ValueError):
                private_credentials(target)
            target.chmod(0o600)
            link = root / "link.json"
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                private_credentials(link)
            target.write_text(json.dumps({"api_url": "https://hosted.supabase.co", "anon_key": "fixture-anon", "service_role_key": "fixture-service"}))
            with self.assertRaises(ValueError):
                private_credentials(target)

    def test_external_redirect_and_authority_paths_are_refused_before_requests(self):
        redirects = LocalRedirects()
        with self.assertRaises(ValueError):
            redirects.redirect_request(Request("http://127.0.0.1:54321"), None, 302, "", {}, "https://elsewhere.invalid/path")
        api = LocalAPI({"url": "http://127.0.0.1:54321", "anon": "fixture", "service": "fixture"}, [])
        with self.assertRaises(ValueError):
            api.request("GET", "//elsewhere.invalid/path")


if __name__ == "__main__":
    unittest.main()
