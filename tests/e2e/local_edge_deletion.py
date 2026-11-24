"""Delete a synthetic account through Chromium and the local Supabase Edge worker.

Requires a built SPA configured for the same disposable local Supabase target.
Normally the runtime resolves the release handler's pinned JSR dependency.
For an offline runtime, --offline-function-copy can install an import map and
the locked npm distribution in a disposable copy of the functions directory.
Pass the path to the copy of delete-account. Leave this option out when the
runtime already has its dependencies. Evidence is written to a fresh directory.
"""

import argparse
import hashlib
import json
import os
import secrets
import subprocess
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

from local_e2e import LocalAPI, PNG, local_url, private_credentials


PROJECT = Path(__file__).resolve().parents[2]
HANDLER = PROJECT / "supabase/functions/delete-account"


def configure_offline_copy(destination):
    """Install only matching dependency files outside every Git checkout."""
    destination = destination.resolve(strict=True)
    in_git = subprocess.run(
        ["git", "-C", str(destination), "rev-parse", "--is-inside-work-tree"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ).returncode == 0
    if in_git or destination.name != "delete-account":
        raise ValueError("The offline target must be a disposable delete-account copy outside Git.")
    for filename in ("index.ts", "../_shared/http.ts"):
        if (destination / filename).read_bytes() != (HANDLER / filename).read_bytes():
            raise ValueError(f"The disposable runtime differs from the release source at {filename}.")

    sdk = PROJECT / "node_modules/@supabase/supabase-js"
    version = json.loads((sdk / "package.json").read_text())["version"]
    locked = json.loads((PROJECT / "package-lock.json").read_text())["packages"]["node_modules/@supabase/supabase-js"]["version"]
    specifier = f"jsr:@supabase/supabase-js@{version}"
    if locked != version or f'"{specifier}"' not in (HANDLER / "index.ts").read_text():
        raise ValueError("Install the matching, locked Supabase SDK before configuring the offline runtime.")
    sdk_bytes = (sdk / "dist/umd/supabase.js").read_bytes()
    module = destination / "sdk.mjs"
    config = destination / "deno.json"
    imports = {"imports": {specifier: "./sdk.mjs"}}
    wrapped = sdk_bytes + b"\nexport const createClient = supabase.createClient;\n"
    if module.is_symlink() or config.is_symlink():
        raise ValueError("The offline SDK and map paths must be ordinary files.")
    if module.exists() and module.read_bytes() != wrapped:
        raise ValueError("A different SDK already exists in the disposable runtime.")
    if config.exists() and json.loads(config.read_text()) != imports:
        raise ValueError("A different Deno configuration already exists in the disposable runtime.")
    if not module.exists():
        with module.open("xb") as stream:
            stream.write(wrapped)
    if not config.exists():
        with config.open("x") as stream:
            json.dump(imports, stream)
    return {"sdk_version": version, "sdk_distribution_sha256": hashlib.sha256(sdk_bytes).hexdigest()}


def browser_deletion(browser, base, target, api, uid, email, password, report):
    allowed = {urlsplit(base).netloc, urlsplit(target["url"]).netloc}
    external_requests, runtime_errors = [], []
    route_path = "/functions/v1/delete-account"
    invocations = []
    context = browser.new_context(base_url=base, service_workers="block")

    def guard(route):
        url = urlsplit(route.request.url)
        if url.scheme in ("blob", "data"):
            route.continue_()
            return
        if url.netloc not in allowed:
            external_requests.append(url.hostname)
            route.abort()
            return
        if route.request.method == "POST" and url.path == route_path:
            # The browser must authenticate as this execution's own fixture
            # before we allow its permanent-deletion request onto the wire.
            auth = route.request.all_headers().get("authorization", "")
            verified = None
            if auth.startswith("Bearer ") and url.netloc == urlsplit(target["url"]).netloc:
                status, user = api.request("GET", "/auth/v1/user", token=auth[7:])
                if status == 200:
                    verified = user
            if not verified or (verified.get("id"), verified.get("email")) != (uid, email):
                route.abort()
                return
            invocations.append(True)
        route.continue_()

    def guard_ws(route):
        if urlsplit(route.url).netloc in allowed:
            route.connect_to_server()
        else:
            external_requests.append(urlsplit(route.url).hostname)
            route.close()

    try:
        context.route("**/*", guard)
        context.route_web_socket("**/*", guard_ws)
        page = context.new_page()
        page.set_default_timeout(15000)
        page.on("pageerror", lambda error: runtime_errors.append(type(error).__name__))
        page.goto("/login")
        page.get_by_label("Email", exact=True).fill(email)
        page.get_by_label("Password", exact=True).fill(password)
        page.get_by_role("button", name="Sign in", exact=True).click()
        expect(page.get_by_role("button", name="Open Work", exact=True)).to_be_visible(timeout=30000)
        api.ok("POST", "/rest/v1/rpc/prepare_identity_deletion", admin=True, body={"p_owner_id": uid})
        page.reload(wait_until="domcontentloaded")
        expect(page.get_by_text("Account needs attention", exact=True)).to_be_visible()
        page.get_by_role("button", name="Account recovery / continue deletion", exact=True).click()
        confirm = page.get_by_label("Type DELETE to confirm", exact=True)
        expect(confirm).to_be_visible()
        report["checks"].append("Account recovery resumed a persisted pending deletion.")
        report["step"] = "confirm deletion in the Account screen"
        confirm.fill("DELETE")
        button = page.get_by_role("button", name="Permanently delete account", exact=True).or_(
            page.get_by_role("button", name="Continue account deletion", exact=True))
        with page.expect_response(lambda r: r.request.method == "POST" and urlsplit(r.url).path == route_path,
                                  timeout=35000) as deletion:
            button.click()
        report["worker_status"] = deletion.value.status
        assert invocations == [True] and deletion.value.status == 200 and deletion.value.json().get("success") is True
        expect(page.get_by_role("button", name="Sign in", exact=True)).to_be_visible(timeout=15000)
        page.reload()
        expect(page.get_by_role("button", name="Sign in", exact=True)).to_be_visible()
        assert not runtime_errors and not external_requests
        report["checks"].append("The release worker returned success. The browser stayed signed out after reload.")
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--credentials-file", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--allow-disposable-local", required=True, action="store_true")
    parser.add_argument("--browser", default="/usr/bin/chromium")
    parser.add_argument("--offline-function-copy", type=Path)
    args = parser.parse_args()
    try:
        base = local_url(args.base_url, root=True)
        target = private_credentials(args.credentials_file)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    os.umask(0o077)
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    report = {"status": "failed", "step": "check local runtime", "checks": [],
              "release_handler_sha256": hashlib.sha256((HANDLER / "index.ts").read_bytes()).hexdigest()}
    api = LocalAPI(target, [target["anon"], target["service"]])
    email = f"rentview-edge-delete-{uuid4().hex[:12]}@example.test"
    password = secrets.token_urlsafe(30)
    api.secret_values.append(password)
    uid = None
    try:
        if args.offline_function_copy:
            report["offline_runtime"] = configure_offline_copy(args.offline_function_copy)
        report["step"] = "create and verify the synthetic owner"
        uid = api.admin_user(email, password, "Fixture Edge deletion")
        principal = api.ok("GET", "/auth/v1/admin/users/" + uid, admin=True)
        login_uid, token = api.login(email, password)
        assert principal["email_confirmed_at"] and (login_uid, principal["email"]) == (uid, email)
        report["checks"].append("The synthetic owner had a confirmed email and a working session.")
        report["step"] = "create open work, upload a photo, and verify stored bytes"
        prop = api.insert("properties", {"owner_id": uid, "name": "Fixture boiler room"}, token)
        job = api.insert("work_orders", {"owner_id": uid, "property_id": prop["id"], "title": "Fixture inspection"}, token)
        assert job["status"] == "open"
        storage_path = f"{uid}/work_orders/{job['id']}/fixture.png"
        api.ok("POST", "/storage/v1/object/attachments/" + storage_path, token=token, body=PNG,
               headers={"Content-Type": "image/png"})
        doc = api.insert("documents", {"owner_id": uid, "property_id": prop["id"], "work_order_id": job["id"],
                         "name": "Fixture inspection photo", "doc_type": "photo", "storage_path": storage_path,
                         "mime_type": "image/png", "size_bytes": len(PNG)}, token)
        assert api.ok("GET", "/storage/v1/object/authenticated/attachments/" + storage_path, token=token) == PNG
        listing = {"prefix": storage_path.rsplit("/", 1)[0], "limit": 10}
        list_path = "/storage/v1/object/list/attachments"
        assert [item["name"] for item in api.ok("POST", list_path, admin=True, body=listing)] == ["fixture.png"]
        report["checks"].append("An open work order, its property, document metadata, and private photo bytes existed.")
        report["step"] = "sign in and resume pending deletion"
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.browser, args=["--no-sandbox", "--disable-background-networking"])
            try:
                browser_deletion(browser, base, target, api, uid, email, password, report)
            finally:
                browser.close()
        report["step"] = "verify absence independently in Auth, Storage, and the database"
        status, _ = api.request("GET", "/auth/v1/admin/users/" + uid, admin=True)
        assert status == 404
        assert api.ok("POST", list_path, admin=True, body=listing) == []
        for table, row in (("properties", prop), ("work_orders", job), ("documents", doc)):
            query = urlencode({"select": "id", "id": "eq." + row["id"]})
            assert api.ok("GET", f"/rest/v1/{table}?{query}", admin=True) == []
        report["checks"].append("Auth returned 404. Independent reads found no private photo, property, work order, or document row.")
        report["status"] = "passed"
    except Exception as error:
        report["failure_type"] = type(error).__name__
    finally:
        if uid:
            try:
                status, _ = api.request("GET", "/auth/v1/admin/users/" + uid, admin=True)
                if status == 200:
                    report["fallback_cleanup"] = api.cleanup_synthetic_user(uid)["status"]
                    report["status"] = "failed"
                elif status == 404:
                    report["fallback_cleanup"] = "unneeded"
                else:
                    raise RuntimeError("Could not confirm fixture cleanup.")
            except Exception as error:
                report.update(status="failed", cleanup_failure_type=type(error).__name__)
        output = args.output / "results.json"
        output.write_text(json.dumps(report, indent=2) + "\n")
        print(f"{report['status']}: {len(report['checks'])} account-deletion checks. Report: {output}")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
