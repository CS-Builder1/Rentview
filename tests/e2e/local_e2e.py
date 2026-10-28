"""Real browser -> disposable local Supabase Auth/Data/Storage integration.

This suite never accepts a hosted backend. Credentials stay in a private scratch
file, request traffic is restricted to loopback, and no provider is activated.
Run only after migrations and the local-key production export are ready.
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import time
from threading import Barrier
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import uuid4

LOOPBACK = {"localhost", "127.0.0.1", "::1"}
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvH0AAAAASUVORK5CYII=")


def local_url(value: str, *, root: bool = False) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in LOOPBACK:
        raise ValueError("Refusing a non-loopback test target. No service was contacted.")
    if parsed.username or parsed.password or parsed.fragment or (root and (parsed.query or parsed.path not in {"", "/"})):
        raise ValueError("Connection overrides and non-root test targets are refused.")
    return value.rstrip("/") if root else value


def private_credentials(path: Path) -> dict:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError("Local credentials must be a regular owner-only file (mode 0600 or 0400).")
    if info.st_uid != os.getuid() or info.st_size > 65536:
        raise ValueError("Local credentials file has an unexpected owner or size.")
    raw = json.loads(path.read_text())
    target = {
        "url": raw.get("api_url") or raw.get("API_URL") or raw.get("url"),
        "anon": raw.get("anon_key") or raw.get("ANON_KEY") or raw.get("publishable_key"),
        "service": raw.get("service_role_key") or raw.get("SERVICE_ROLE_KEY") or raw.get("service_key"),
    }
    if not all(isinstance(value, str) and value for value in target.values()):
        raise ValueError("The private target file needs api_url, anon_key and service_role_key.")
    target["url"] = local_url(target["url"], root=True)
    return target


class LocalRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        local_url(newurl)
        return super().redirect_request(request, response, code, message, headers, newurl)


class LocalAPI:
    def __init__(self, target, secret_values):
        self.base, self.anon, self.service = target["url"], target["anon"], target["service"]
        self.secret_values = secret_values
        # Loopback requests do not traverse ambient proxies or credential injectors.
        self.http = build_opener(ProxyHandler({}), LocalRedirects())

    def request(self, method, path, *, token=None, admin=False, body=None, headers=None):
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("Invalid local API path.")
        address = local_url(self.base + path)
        key = self.service if admin else self.anon
        request_headers = {"apikey": key, "Authorization": "Bearer " + (key if admin else token or self.anon)}
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body).encode()
            request_headers["Content-Type"] = "application/json"
        request_headers.update(headers or {})
        request = Request(address, data=body, headers=request_headers, method=method)
        try:
            response = self.http.open(request, timeout=12)
        except HTTPError as failure:
            response = failure
        status = response.status
        raw = response.read()
        try:
            data = json.loads(raw) if raw else None
        except (json.JSONDecodeError, UnicodeDecodeError):
            data = raw
        return status, data

    def ok(self, method, path, **kwargs):
        status, data = self.request(method, path, **kwargs)
        if status < 200 or status >= 300:
            code = data.get("code", "") if isinstance(data, dict) else ""
            raise AssertionError(f"Local API {method} {urlparse(path).path} failed ({status}, {code}).")
        return data

    def insert(self, table, values, token):
        rows = self.ok("POST", f"/rest/v1/{table}", token=token, body=values, headers={"Prefer": "return=representation"})
        assert isinstance(rows, list) and len(rows) == 1, "Insert did not return one row."
        return rows[0]

    def select(self, table, token, **filters):
        query = {"select": "*", **{name: "eq." + str(value) for name, value in filters.items()}}
        return self.ok("GET", f"/rest/v1/{table}?{urlencode(query)}", token=token)

    def patch(self, table, row_id, values, token=None, admin=False):
        return self.ok("PATCH", f"/rest/v1/{table}?id=eq.{row_id}", token=token, admin=admin, body=values, headers={"Prefer": "return=representation"})

    def rpc(self, name, args, token):
        return self.ok("POST", f"/rest/v1/rpc/{name}", token=token, body=args)

    def denied(self, method, path, *, statuses=(400, 403, 409), codes=("42501", "23514", "23503"), allow_empty=False, **kwargs):
        status, data = self.request(method, path, **kwargs)
        if allow_empty and 200 <= status < 300 and data == []:
            return status
        assert status in statuses, f"Expected an authorization/domain rejection; got HTTP {status}."
        if codes is not None:
            code = data.get("code") if isinstance(data, dict) else None
            assert code in codes, f"Expected an authorization/domain error code; got {code}."
        return status

    def admin_user(self, email, password, label):
        user = self.ok("POST", "/auth/v1/admin/users", admin=True, body={"email": email, "password": password, "email_confirm": True, "user_metadata": {"full_name": label}})
        return user["id"]

    def login(self, email, password):
        data = self.ok("POST", "/auth/v1/token?grant_type=password", body={"email": email, "password": password})
        self.secret_values.extend([data["access_token"], data["refresh_token"]])
        return data["user"]["id"], data["access_token"]


def poll(fn, *, timeout=20, pump=None):
    deadline = time.monotonic() + timeout
    while True:
        result = fn()
        if result:
            return result
        if time.monotonic() >= deadline:
            raise AssertionError("Expected local data did not become available in time.")
        if pump:
            # Sync Playwright dispatches route guards only inside its API calls.
            # Blocking urllib/sleep loops otherwise stall genuine browser HTTP.
            pump(250)
        else:
            time.sleep(0.25)


def protect_file(path: Path):
    if path.exists():
        path.chmod(0o600)


def race(fn, values):
    """Release independent HTTP requests together rather than rely on scheduling."""
    barrier = Barrier(len(values), timeout=12)
    def start(value):
        barrier.wait()
        return fn(value)
    with ThreadPoolExecutor(max_workers=len(values)) as workers:
        return list(workers.map(start, values))


def one_winner(responses):
    successful = [index for index, (status, _) in enumerate(responses) if 200 <= status < 300]
    assert len(successful) == 1, "A constrained race did not have exactly one successful write."
    for status, data in responses:
        if 200 <= status < 300:
            continue
        assert status in (400, 409) and isinstance(data, dict) and data.get("code") == "23514", "A competing write failed for an unexpected reason."
    return successful[0]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--credentials-file", required=True, type=Path)
    parser.add_argument("--allow-disposable-local", action="store_true")
    parser.add_argument("--output", type=Path, default=Path("/workspace/scratch/rentview-local-e2e"))
    parser.add_argument("--browser", default="/usr/bin/chromium")
    parser.add_argument("--keep-fixtures", action="store_true")
    parser.add_argument("--check-target", action="store_true", help="Validate target/permission gates without contacting it")
    args = parser.parse_args(argv)
    if not args.allow_disposable_local:
        parser.error("Explicit --allow-disposable-local is required. No service was contacted.")
    try:
        base = local_url(args.base_url, root=True)
        target = private_credentials(args.credentials_file)
    except (ValueError, OSError, json.JSONDecodeError) as failure:
        parser.error(str(failure))
    if args.check_target:
        print(json.dumps({"target": "loopback only", "credentials": "owner-only file", "contacted": False}))
        return 0
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    args.output.chmod(0o700)
    secret_values = [target["anon"], target["service"]]
    api = LocalAPI(target, secret_values)
    result = {"scope": "real browser + local Supabase Auth/Data/Storage; synthetic identities only", "status": "running", "checks": [], "blocked_requests": [], "page_errors": [], "not_run": ["real Google OAuth", "external email delivery and physical-device callbacks", "push/provider payment delivery and Edge runtime integration", "account password recovery and partial-deletion browser flows (unit/handler fixtures are separate)", "financial export, multiple-currency and timezone browser flows (unit fixtures are separate)", "full keyboard/screen-reader and physical-device accessibility audit", "physical-device offline failure matrix and hard reload while disconnected (web export has no service worker)"]}
    run_id = uuid4().hex[:12]
    fixture_users = []
    fixture_paths = []
    contexts = []
    pending_http = {}
    browser = None
    playwright = None
    current_step = "initialization"

    def clean(value):
        text = str(value)
        for secret in sorted(secret_values, key=len, reverse=True):
            if secret:
                text = text.replace(secret, "[fixture-secret]")
        return re.sub(r"eyJ[A-Za-z0-9_.-]{30,}", "[token]", text)

    def checkpoint(name, layer="browser-api-data"):
        result["checks"].append({"name": name, "layer": layer})
        print(json.dumps({"passed": name, "layer": layer}), flush=True)

    def wait_for_data(fn, *, timeout=20):
        active_pages = [page for context in contexts for page in context.pages if not page.is_closed()]
        return poll(fn, timeout=timeout, pump=active_pages[0].wait_for_timeout if active_pages else None)

    def principal(label):
        email = f"rentview-{run_id}-{label}@example.test"
        password = "Rv!" + secrets.token_urlsafe(24)
        secret_values.append(password)
        uid = api.admin_user(email, password, f"Fixture {label}")
        fixture_users.append(uid)
        _, token = api.login(email, password)
        return {"id": uid, "email": email, "password": password, "token": token}

    def wire_context(context):
        contexts.append(context)
        def guard(route):
            parsed = urlparse(route.request.url)
            if parsed.scheme in {"data", "blob"} or parsed.hostname in LOOPBACK:
                route.continue_()
            else:
                result["blocked_requests"].append({"kind": "http", "host": parsed.hostname, "path": parsed.path, "method": route.request.method})
                route.abort("blockedbyclient")
        context.route("**/*", guard)
        if not hasattr(context, "route_web_socket"):
            raise RuntimeError("Playwright WebSocket interception is required; no browser flow was run.")
        def guard_ws(route):
            parsed = urlparse(route.url)
            if parsed.hostname in LOOPBACK:
                route.connect_to_server()
            else:
                result["blocked_requests"].append({"kind": "websocket", "host": parsed.hostname, "path": parsed.path})
                route.close()
        context.route_web_socket("**/*", guard_ws)
        page = context.new_page()
        page.set_default_timeout(25_000)
        def request_started(request):
            parsed = urlparse(request.url)
            if parsed.scheme in {"http", "https"}:
                pending_http[request] = {"method": request.method, "host": parsed.hostname, "path": parsed.path, "started": time.monotonic()}
        page.on("request", request_started)
        page.on("requestfinished", lambda request: pending_http.pop(request, None))
        page.on("requestfailed", lambda request: pending_http.pop(request, None))
        page.on("pageerror", lambda error: result["page_errors"].append(clean(error)))
        page.on("response", lambda response: result.setdefault("http_errors", []).append({"path": urlparse(response.url).path, "status": response.status}) if response.status >= 400 else None)
        page.on("dialog", lambda dialog: dialog.accept())
        return page

    def login_page(page, who):
        page.goto(base + "/login", wait_until="domcontentloaded", timeout=30_000)
        page.get_by_label("Email", exact=True).fill(who["email"])
        page.get_by_label("Password", exact=True).fill(who["password"])
        page.get_by_role("button", name="Sign in", exact=True).click()
        # Match the parsed path. A greedy URL regex can backtrack into http://
        # and incorrectly accept /login before its authentication request ends.
        page.wait_for_url(lambda value: urlparse(value).path.rstrip("/") != "/login", timeout=30_000)
        expect(page.get_by_role("button", name="Open Work", exact=True)).to_be_visible(timeout=30_000)
        review = page.get_by_role("button", name="Review saved changes and refresh problems", exact=True)
        if review.is_visible():
            # Read the product's own diagnostics before later navigation can
            # hide a stale read. No internal cache state is changed or injected.
            review.click()
            expect(page.get_by_text("Information needing refresh", exact=True)).to_be_visible()
            result.setdefault("initial_refresh_notices", []).append(clean(page.locator("body").inner_text())[:2000])
            page.get_by_role("button", name="Back", exact=True).click()
            expect(page.get_by_role("button", name="Open Work", exact=True)).to_be_visible()

    def saved_operations(page, account_id):
        # Observe durable bytes written by the UI; never inject queue state.
        return page.evaluate("""accountId => {
            const raw = localStorage.getItem('rentview.offline.queue.v2.' + accountId);
            return raw === null ? [] : JSON.parse(raw);
        }""", account_id)

    def open_job_form(page, property_id, title):
        # The location must be genuinely loaded before removing connectivity.
        with page.expect_response(lambda response: response.request.method == "GET"
                and urlparse(response.url).path == "/rest/v1/units"
                and parse_qs(urlparse(response.url).query).get("property_id") == ["eq." + property_id]) as location:
            page.goto(base + "/work-orders?" + urlencode({"new": "1", "propertyId": property_id}), wait_until="domcontentloaded")
        assert location.value.status == 200, "The real job location could not be loaded."
        assert isinstance(json.loads(location.value.body()), list), "The real job location response was not a JSON collection."
        page.get_by_label("Title", exact=True).fill(title)
        page.get_by_label("Description (optional)", exact=True).fill("Synthetic browser offline persistence check.")

    def save_while_disconnected(page, who, title):
        page.context.set_offline(True)
        page.wait_for_function("() => navigator.onLine === false")
        expect(page.get_by_text("Offline · showing available saved information", exact=True)).to_be_visible()
        page.get_by_role("button", name="Save", exact=True).click()
        expect(page.get_by_role("dialog")).to_have_count(0)
        page.get_by_role("button", name="Review saved changes and refresh problems", exact=True).click()
        expect(page.get_by_text(title, exact=True)).to_be_visible()
        expect(page.get_by_text("Work order · Waiting to sync", exact=True)).to_be_visible()
        queued = saved_operations(page, who["id"])
        assert len(queued) == 1 and queued[0]["accountId"] == who["id"]
        assert queued[0]["payload"]["owner_id"] == who["id"] and queued[0]["payload"]["title"] == title
        assert queued[0]["status"] == "pending" and queued[0]["attempts"] == 0
        assert api.select("work_orders", who["token"], id=queued[0]["id"]) == []
        return queued[0]["id"]

    def verify_embedded_selects(token):
        # Exercise every actual embedded query against the running Data API.
        # Type checks alone cannot prove its relationship cache is unambiguous.
        sources = {
            "(tabs)/properties.tsx": "properties", "(tabs)/work-orders.tsx": "work_orders",
            "announcements.tsx": "announcements", "asset/[id].tsx": "assets", "assets.tsx": "assets",
            "documents.tsx": "documents", "expenses.tsx": "expenses", "export.tsx": "expenses",
            "inventory.tsx": "inventory_items", "lease/[id].tsx": "leases", "maintenance.tsx": "maintenance_schedules",
            "request/[id].tsx": "maintenance_requests", "requests.tsx": "maintenance_requests",
            "unit/[id].tsx": "units", "work-order/[id].tsx": "work_orders",
        }
        app_root = Path(__file__).resolve().parents[2] / "app" / "(app)"
        for source, table in sources.items():
            strings = re.findall(r'\.select\(\s*("(?:[^"\\]|\\.)*")', (app_root / source).read_text())
            queries = [json.loads(value) for value in strings if "(" in json.loads(value)]
            assert len(queries) == 1, "Embedded-query source changed; review the live query coverage."
            rows = api.ok("GET", "/rest/v1/" + table + "?" + urlencode({"select": queries[0], "limit": 1}), token=token)
            assert isinstance(rows, list), "An embedded query did not return a collection."
        functions_root = app_root.parents[1] / "supabase" / "functions"
        for source, tables in {"send-push/index.ts": ["leases", "maintenance_requests"], "send-reminders/index.ts": ["assets", "maintenance_schedules"]}.items():
            strings = re.findall(r'\.select\(\s*("(?:[^"\\]|\\.)*")', (functions_root / source).read_text())
            queries = [json.loads(value) for value in strings if "(" in json.loads(value)]
            assert len(queries) == len(tables), "Server embedded-query source changed; review the live query coverage."
            for table, query in zip(tables, queries):
                rows = api.ok("GET", "/rest/v1/" + table + "?" + urlencode({"select": query, "limit": 1}), token=token)
                assert isinstance(rows, list), "A server embedded query did not return a collection."
        checkpoint("all 19 app/server embedded query sites resolve against the hardened live Data API", "real-local-api-data")

    try:
        from playwright.sync_api import sync_playwright, expect
        current_step = "local_api_health"
        api.ok("GET", "/auth/v1/health")
        owner = principal("owner-a")
        other_owner = principal("owner-b")
        outsider = principal("unrelated")
        competitor = principal("competing-tenant")
        current_step = "embedded_relationship_queries"
        verify_embedded_selects(owner["token"])
        tenant_email = f"rentview-{run_id}-tenant@example.test"
        tenant_password = "Rv!" + secrets.token_urlsafe(24)
        secret_values.append(tenant_password)
        playwright = sync_playwright().start()
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True, args=["--no-sandbox", "--disable-background-networking"])
        owner_page = wire_context(browser.new_context(viewport={"width": 1440, "height": 1000}, service_workers="block"))
        current_step = "owner_property_unit_lease"
        login_page(owner_page, owner)
        owner_page.goto(base + "/properties", wait_until="domcontentloaded")
        owner_page.get_by_role("button", name="Add property", exact=True).click()
        property_name = "Fixture Mixed Building " + run_id
        owner_page.get_by_label("Name", exact=True).fill(property_name)
        owner_page.get_by_role("button", name="Save", exact=True).click()
        owner_page.wait_for_url(re.compile(r".*/property/[0-9a-f-]+$"))
        expect(owner_page.get_by_text("New property", exact=True)).not_to_be_attached()
        expect(owner_page.get_by_role("dialog")).to_have_count(0)
        property_id = owner_page.url.rsplit("/", 1)[-1]
        assert api.select("properties", owner["token"], id=property_id)[0]["name"] == property_name
        owner_page.get_by_text("Add unit", exact=True).click()
        owner_page.get_by_label("Label", exact=True).fill("Fixture Unit 1")
        owner_page.get_by_role("button", name="Save", exact=True).click()
        unit = wait_for_data(lambda: next(iter(api.select("units", owner["token"], property_id=property_id)), None))
        owner_page.goto(base + "/unit/" + unit["id"], wait_until="domcontentloaded")
        owner_page.get_by_text("Add", exact=True).first.click()
        owner_page.get_by_label("Tenant name", exact=True).fill("Fixture Tenant")
        owner_page.get_by_label("Tenant email (optional)", exact=True).fill(tenant_email)
        owner_page.get_by_label("Rent (USD)", exact=True).fill("500")
        owner_page.get_by_role("button", name="Save", exact=True).click()
        lease = wait_for_data(lambda: next(iter(api.select("leases", owner["token"], unit_id=unit["id"])), None))
        checkpoint("owner creates property, unit and active lease through UI")

        current_step = "invite_signup_continuation"
        owner_page.goto(base + "/lease/" + lease["id"], wait_until="domcontentloaded")
        owner_page.get_by_role("button", name="Generate tenant invitation", exact=True).click()
        invite = wait_for_data(lambda: next(iter(api.select("tenant_invites", owner["token"], lease_id=lease["id"])), None))
        secret_values.append(invite["code"])
        tenant_page = wire_context(browser.new_context(viewport={"width": 390, "height": 844}, service_workers="block"))
        tenant_page.goto(base + "/claim?" + urlencode({"code": invite["code"]}), wait_until="domcontentloaded")
        tenant_page.get_by_role("button", name="Continue to sign in or create account", exact=True).click()
        tenant_page.get_by_role("button", name="No account yet? Create one", exact=True).click()
        tenant_page.get_by_label("Full name", exact=True).fill("Fixture Tenant")
        tenant_page.get_by_label("Email", exact=True).fill(tenant_email)
        tenant_page.get_by_label("Password (at least 12 characters)", exact=True).fill(tenant_password)
        tenant_page.get_by_role("button", name="Create account", exact=True).click()
        # Local stacks may require confirmation. Confirm only this synthetic
        # address through the local admin API, then continue real UI sign-in.
        users = wait_for_data(lambda: next((user for user in api.ok("GET", "/auth/v1/admin/users?page=1&per_page=1000", admin=True)["users"] if user["email"] == tenant_email), None))
        fixture_users.append(users["id"])
        if not users.get("email_confirmed_at"):
            api.ok("PUT", "/auth/v1/admin/users/" + users["id"], admin=True, body={"email_confirm": True})
            expect(tenant_page.get_by_role("button", name="Sign in", exact=True)).to_be_visible()
            tenant_page.get_by_label("Password", exact=True).fill(tenant_password)
            tenant_page.get_by_role("button", name="Sign in", exact=True).click()
            result["not_run"].append("signup confirmation email click: synthetic account confirmed via local admin")
        tenant_page.get_by_role("button", name="Join lease", exact=True).click()
        tenant_page.wait_for_url(re.compile(r".*/tenant/?$"))
        tenant_id, tenant_token = api.login(tenant_email, tenant_password)
        tenant = {"id": tenant_id, "token": tenant_token}
        assert api.select("leases", owner["token"], id=lease["id"])[0]["tenant_user_id"] == tenant_id
        expect(tenant_page.get_by_text(property_name, exact=False).first).to_be_visible()
        checkpoint("tenant signup preserves invitation, claims verified lease, reaches tenant portal")

        current_step = "owner_refreshes_claimed_lease"
        owner_page.get_by_role("button", name="Refresh lease", exact=True).click()
        expect(owner_page.get_by_text("This tenant has portal access.", exact=True)).to_be_visible()
        expect(owner_page.get_by_role("button", name="Remove portal access", exact=True)).to_be_visible()
        expect(owner_page.get_by_role("button", name="Copy invitation link", exact=True)).not_to_be_attached()
        expect(owner_page.get_by_role("button", name="Revoke", exact=True)).not_to_be_attached()
        checkpoint("owner refreshes the lease after a separate-device claim and sees current portal access")

        current_step = "request_photo_message"
        tenant_page.get_by_role("button", name="Report a repair", exact=True).click()
        tenant_page.get_by_label("What's wrong", exact=True).fill("Fixture kitchen leak " + run_id)
        tenant_page.get_by_label("Details", exact=True).fill("Water appears under the fixture tap during normal use.")
        tenant_page.get_by_label("When can someone visit? (optional)", exact=True).fill("Weekdays after 16:00")
        with tenant_page.expect_file_chooser() as picker:
            tenant_page.get_by_role("button", name="Add photo", exact=True).click()
        picker.value.set_files({"name": "fixture-repair.png", "mimeType": "image/png", "buffer": PNG})
        expect(tenant_page.get_by_label("Selected photo 1", exact=True)).to_be_visible()
        tenant_page.get_by_role("button", name="Submit request", exact=True).click()
        tenant_page.wait_for_url(re.compile(r".*/tenant/request/[0-9a-f-]+$"))
        request_id = tenant_page.url.rsplit("/", 1)[-1]
        photos = wait_for_data(lambda: api.select("request_photos", tenant_token, request_id=request_id))
        photo = photos[0]
        fixture_paths.append(photo["storage_path"])
        assert api.ok("GET", "/storage/v1/object/authenticated/attachments/" + quote(photo["storage_path"], safe="/"), token=tenant_token).startswith((b"\x89PNG", b"\xff\xd8\xff", b"GIF8", b"RIFF"))
        tenant_page.get_by_label("Message to the other participant", exact=True).fill("Fixture tenant message " + run_id)
        tenant_page.get_by_role("button", name="Send message", exact=True).click()
        wait_for_data(lambda: any(row["body"] == "Fixture tenant message " + run_id for row in api.select("request_messages", owner["token"], request_id=request_id)))
        owner_page.goto(base + "/request/" + request_id, wait_until="domcontentloaded")
        expect(owner_page.get_by_text("Fixture tenant message " + run_id, exact=True)).to_be_visible()
        owner_page.get_by_role("button", name="Open repair photo 1", exact=True).click()
        expect(owner_page.get_by_role("button", name="Close photo", exact=True)).to_be_visible()
        owner_page.get_by_role("button", name="Close photo", exact=True).click()
        owner_page.get_by_label("Message to the other participant", exact=True).fill("Fixture owner reply " + run_id)
        owner_page.get_by_role("button", name="Send message", exact=True).click()
        expect(tenant_page.get_by_text("Fixture owner reply " + run_id, exact=True)).to_be_visible(timeout=25_000)
        checkpoint("tenant submits repair/photo; both participants inspect real stored bytes and exchange visible messages")

        current_step = "repair_conversion_stock_completion"
        owner_page.get_by_role("button", name="Convert to work order", exact=True).click()
        owner_page.wait_for_url(re.compile(r".*/work-order/[0-9a-f-]+$"))
        work_order_id = owner_page.url.rsplit("/", 1)[-1]
        assert api.rpc("convert_request_to_work_order", {"p_request_id": request_id}, owner["token"]) == work_order_id
        assert len(api.select("work_orders", owner["token"], property_id=property_id)) == 1
        vendor = api.insert("vendors", {"owner_id": owner["id"], "name": "Fixture Vendor " + run_id}, owner["token"])
        asset = api.insert("assets", {"owner_id": owner["id"], "property_id": property_id, "unit_id": unit["id"], "name": "Fixture Pump " + run_id}, owner["token"])
        stock = api.insert("inventory_items", {"owner_id": owner["id"], "property_id": property_id, "unit_id": unit["id"], "name": "Fixture Seal " + run_id, "quantity": 5, "unit_cost": 10, "cost_currency": "USD"}, owner["token"])
        api.patch("work_orders", work_order_id, {"asset_id": asset["id"]}, owner["token"])
        owner_page.reload(wait_until="domcontentloaded")
        owner_page.get_by_text(vendor["name"], exact=True).click()
        wait_for_data(lambda: api.select("work_orders", owner["token"], id=work_order_id)[0]["vendor_id"] == vendor["id"])
        owner_page.get_by_text("Add", exact=True).first.click()
        owner_page.get_by_role("button", name=f"{stock['name']} (5 available)", exact=True).click()
        owner_page.get_by_label("Quantity", exact=True).fill("2")
        owner_page.get_by_role("button", name="Save", exact=True).click()
        part = wait_for_data(lambda: next(iter(api.select("work_order_parts", owner["token"], work_order_id=work_order_id)), None))
        assert float(api.select("inventory_items", owner["token"], id=stock["id"])[0]["quantity"]) == 3
        operation = part["operation_input"]
        assert api.rpc("add_work_order_part", {"p_work_order_id": work_order_id, "p_inventory_item_id": operation["inventory_item_id"], "p_description": operation["description"], "p_quantity": operation["quantity"], "p_unit_cost": operation["unit_cost"], "p_currency": operation["currency"], "p_operation_id": part["id"]}, owner["token"]) == part["id"]
        assert float(api.select("inventory_items", owner["token"], id=stock["id"])[0]["quantity"]) == 3
        owner_page.get_by_text("Completed", exact=True).click()
        owner_page.get_by_label("What was done?", exact=True).fill("Fixture seal replaced and tested")
        owner_page.get_by_label("Labor cost (USD)", exact=True).fill("30")
        owner_page.get_by_role("button", name="Complete and record cost", exact=True).click()
        completed = wait_for_data(lambda: next((row for row in api.select("work_orders", owner["token"], id=work_order_id) if row["completion_expense_id"]), None))
        expense_id = completed["completion_expense_id"]
        assert api.rpc("complete_work_order", {"p_work_order_id": work_order_id, "p_labor_amount": 30, "p_currency": "USD", "p_summary": "Fixture seal replaced and tested", "p_use_existing_expenses": False}, owner["token"]) == expense_id
        expenses = api.select("expenses", owner["token"], work_order_id=work_order_id)
        assert len(expenses) == 1 and float(expenses[0]["amount"]) == 50
        assert api.select("maintenance_requests", owner["token"], id=request_id)[0]["status"] == "resolved"
        owner_page.goto(base + "/asset/" + asset["id"], wait_until="domcontentloaded")
        expect(owner_page.get_by_text("Fixture kitchen leak " + run_id, exact=True)).to_be_visible()
        totals = api.rpc("asset_cost_totals", {"p_asset_id": asset["id"]}, owner["token"])
        assert len(totals) == 1 and totals[0]["currency"] == "USD" and float(totals[0]["total"]) == 50
        checkpoint("owner converts once, assigns vendor, consumes stock once, completes once with USD50 expense and asset history")

        current_step = "rating_close_reopen"
        tenant_page.reload(wait_until="domcontentloaded")
        tenant_page.get_by_role("radio", name="4 out of 5 stars", exact=True).click()
        tenant_page.get_by_label("Anything to add?", exact=True).fill("Fixture repair review")
        tenant_page.get_by_role("button", name="Submit rating", exact=True).click()
        wait_for_data(lambda: api.select("maintenance_requests", owner["token"], id=request_id)[0]["rating"] == 4)
        tenant_page.get_by_role("button", name="Close this request", exact=True).click()
        wait_for_data(lambda: api.select("maintenance_requests", owner["token"], id=request_id)[0]["status"] == "closed")
        api.denied("POST", "/rest/v1/request_messages", token=tenant_token, body={"request_id": request_id, "sender_id": tenant_id, "body": "Must be refused while closed"})
        tenant_page.get_by_label("What still needs attention?", exact=True).fill("Fixture leak returned after repair")
        tenant_page.get_by_role("button", name="Reopen request", exact=True).click()
        reopened = wait_for_data(lambda: next((row for row in api.select("maintenance_requests", owner["token"], id=request_id) if row["status"] == "submitted"), None))
        assert reopened["work_order_id"] is None and reopened["rating"] is None
        assert api.select("work_orders", owner["token"], id=work_order_id)[0]["completion_expense_id"] == expense_id
        checkpoint("tenant rates, closes and reopens while completed costs/history remain immutable")

        current_step = "offline_enqueue_reconnect"
        offline_title = "Fixture offline reconnect " + run_id
        open_job_form(owner_page, property_id, offline_title)
        offline_id = save_while_disconnected(owner_page, owner, offline_title)
        owner_page.context.set_offline(False)
        owner_page.wait_for_function("() => navigator.onLine === true")
        expect(owner_page.get_by_text("No changes waiting to sync.", exact=True)).to_be_visible()
        uploaded = wait_for_data(lambda: api.select("work_orders", owner["token"], id=offline_id))
        assert len(uploaded) == 1 and uploaded[0]["title"] == offline_title
        assert len(api.select("work_orders", owner["token"], title=offline_title)) == 1
        assert saved_operations(owner_page, owner["id"]) == []
        owner_page.reload(wait_until="domcontentloaded")
        expect(owner_page.get_by_text("No changes waiting to sync.", exact=True)).to_be_visible()
        assert len(api.select("work_orders", owner["token"], title=offline_title)) == 1
        checkpoint("browser queues a job without connectivity, reconnects to one real row, and reloads without duplicating it")

        current_step = "offline_failure_reload_retry"
        temporary = api.insert("properties", {"owner_id": owner["id"], "name": "Fixture disappearing offline location " + run_id}, owner["token"])
        failed_title = "Fixture offline stale location " + run_id
        open_job_form(owner_page, temporary["id"], failed_title)
        failed_id = save_while_disconnected(owner_page, owner, failed_title)
        # A separate real session removes only this synthetic parent while
        # the browser is offline. Reconnection reaches the actual FK guard.
        deleted = api.ok("DELETE", "/rest/v1/properties?id=eq." + temporary["id"], token=owner["token"], headers={"Prefer": "return=representation"})
        assert len(deleted) == 1 and deleted[0]["id"] == temporary["id"]
        owner_page.context.set_offline(False)
        expect(owner_page.get_by_text("Work order · Needs attention", exact=True)).to_be_visible()
        failed_queue = saved_operations(owner_page, owner["id"])
        assert len(failed_queue) == 1 and failed_queue[0]["id"] == failed_id
        assert failed_queue[0]["status"] == "failed" and failed_queue[0]["attempts"] == 1 and failed_queue[0]["error"]
        assert api.select("work_orders", owner["token"], id=failed_id) == []
        owner_page.reload(wait_until="domcontentloaded")
        expect(owner_page.get_by_text(failed_title, exact=True)).to_be_visible()
        expect(owner_page.get_by_text("Work order · Needs attention", exact=True)).to_be_visible()
        reloaded_queue = saved_operations(owner_page, owner["id"])
        assert reloaded_queue == failed_queue, "Reload changed or lost a failed saved operation."
        owner_page.get_by_role("button", name="Retry", exact=True).click()
        wait_for_data(lambda: any(row["id"] == failed_id and row["status"] == "failed" and row["attempts"] == 2 for row in saved_operations(owner_page, owner["id"])))
        expect(owner_page.get_by_text(failed_title, exact=True)).to_be_visible()
        assert api.select("work_orders", owner["token"], id=failed_id) == []
        owner_page.get_by_role("button", name="Discard saved change", exact=True).click()
        expect(owner_page.get_by_text("No changes waiting to sync.", exact=True)).to_be_visible()
        assert saved_operations(owner_page, owner["id"]) == []
        assert api.select("work_orders", owner["token"], id=failed_id) == []
        checkpoint("a real FK rejection remains saved across reload/retry until the owner explicitly discards it")

        current_step = "authorization_denials"
        for principal_token in [other_owner["token"], outsider["token"]]:
            assert api.select("maintenance_requests", principal_token, id=request_id) == []
            assert api.select("request_messages", principal_token, request_id=request_id) == []
            assert api.select("request_photos", principal_token, request_id=request_id) == []
            api.denied("GET", "/storage/v1/object/authenticated/attachments/" + quote(photo["storage_path"], safe="/"), token=principal_token, statuses=(400, 403, 404), codes=None)
        assert api.select("properties", other_owner["token"], id=property_id) == []
        api.denied("PATCH", "/rest/v1/properties?id=eq." + property_id, token=other_owner["token"], body={"name": "Must not replace owner name"}, headers={"Prefer": "return=representation"}, allow_empty=True)
        api.denied("DELETE", "/rest/v1/properties?id=eq." + property_id, token=other_owner["token"], headers={"Prefer": "return=representation"}, allow_empty=True)
        assert api.select("properties", owner["token"], id=property_id)[0]["name"] == property_name
        api.denied("POST", "/rest/v1/units", token=other_owner["token"], body={"owner_id": other_owner["id"], "property_id": property_id, "label": "Forged cross-owner unit"})
        api.denied("POST", "/rest/v1/tenant_invites", token=other_owner["token"], body={"owner_id": other_owner["id"], "lease_id": lease["id"], "code": uuid4().hex.upper()})
        api.denied("POST", "/rest/v1/rpc/create_tenant_invite", token=other_owner["token"], body={"p_lease_id": lease["id"], "p_email": outsider["email"]})
        api.denied("POST", "/rest/v1/subscriptions", token=other_owner["token"], body={"owner_id": other_owner["id"], "provider": "lemonsqueezy", "plan": "pro", "status": "active"})
        assert api.select("subscriptions", other_owner["token"], owner_id=other_owner["id"]) == []
        api.denied("PATCH", "/rest/v1/maintenance_requests?id=eq." + request_id, token=tenant_token, body={"owner_id": outsider["id"], "status": "resolved"}, headers={"Prefer": "return=representation"}, allow_empty=True)
        unchanged = api.select("maintenance_requests", owner["token"], id=request_id)[0]
        assert unchanged["owner_id"] == owner["id"] and unchanged["status"] == "submitted"
        api.denied("GET", "/rest/v1/properties?select=id", token="malformed-fixture-jwt", statuses=(401,), codes=("PGRST301",))
        api.denied("POST", "/rest/v1/rpc/claim_tenant_invite", token=outsider["token"], body={"invite_code": "INVALIDCODE"})
        api.denied("POST", "/rest/v1/rpc/claim_tenant_invite", token=outsider["token"], body={"invite_code": invite["code"]})
        api.denied("POST", "/rest/v1/work_orders", token=owner["token"], body={"owner_id": owner["id"], "property_id": property_id, "title": "Forged completed history", "status": "completed"})
        blocked_upload = "requests/" + request_id + "/" + str(uuid4()) + ".png"
        fixture_paths.append(blocked_upload)
        api.denied("POST", "/storage/v1/object/attachments/" + blocked_upload, token=tenant_token, body=b"<html><script>throw Error('fixture')</script></html>", headers={"Content-Type": "text/html"}, statuses=(400, 403, 415), codes=None)
        checkpoint("cross-owner reads/refs, forged invitation, direct Pro, tenant workflow edits and malformed auth are refused", "real-local-api-data")

        current_step = "concurrent_capacity_stock_claims"
        for index in range(2):
            api.insert("properties", {"owner_id": other_owner["id"], "name": f"Fixture capacity {index}", "property_type": "residential", "currency": "USD"}, other_owner["token"])
        def competing_property(index):
            return api.request("POST", "/rest/v1/properties", token=other_owner["token"], body={"owner_id": other_owner["id"], "name": f"Fixture raced capacity {index}", "property_type": "residential", "currency": "USD"})
        capacity = race(competing_property, [1, 2])
        one_winner(capacity)
        assert len(api.select("properties", other_owner["token"], owner_id=other_owner["id"])) == 3
        race_job = api.insert("work_orders", {"owner_id": owner["id"], "property_id": property_id, "unit_id": unit["id"], "title": "Fixture competing stock"}, owner["token"])
        def competing_part(_):
            return api.request("POST", "/rest/v1/rpc/add_work_order_part", token=owner["token"], body={"p_work_order_id": race_job["id"], "p_inventory_item_id": stock["id"], "p_description": stock["name"], "p_quantity": 2, "p_unit_cost": 10, "p_currency": "USD", "p_operation_id": str(uuid4())})
        stock_results = race(competing_part, [1, 2])
        one_winner(stock_results)
        assert float(api.select("inventory_items", owner["token"], id=stock["id"])[0]["quantity"]) == 1
        negative_unit = api.insert("units", {"owner_id": owner["id"], "property_id": property_id, "label": "Fixture negative cases"}, owner["token"])
        race_lease = api.insert("leases", {"owner_id": owner["id"], "unit_id": negative_unit["id"], "tenant_name": "Fixture competing tenants", "status": "active"}, owner["token"])
        race_invite = api.rpc("create_tenant_invite", {"p_lease_id": race_lease["id"], "p_email": None}, owner["token"])
        secret_values.append(race_invite["code"])
        def competing_claim(who):
            return api.request("POST", "/rest/v1/rpc/claim_tenant_invite", token=who["token"], body={"invite_code": race_invite["code"]})
        claimants = [outsider, competitor]
        claims = race(competing_claim, claimants)
        winner = claimants[one_winner(claims)]
        linked_race = api.select("leases", owner["token"], id=race_lease["id"])[0]
        assert linked_race["tenant_user_id"] == winner["id"]
        api.patch("leases", race_lease["id"], {"status": "expired"}, owner["token"])
        api.denied("POST", "/rest/v1/maintenance_requests", token=winner["token"], body={"owner_id": owner["id"], "lease_id": race_lease["id"], "unit_id": negative_unit["id"], "property_id": property_id, "tenant_user_id": winner["id"], "title": "Inactive lease must refuse repair"})
        checkpoint("concurrent capacity, stock and invitation claims preserve limits; inactive lease cannot submit", "real-local-api-data")

        current_step = "expiry_and_revocation"
        expired_lease = api.insert("leases", {"owner_id": owner["id"], "unit_id": negative_unit["id"], "tenant_name": "Fixture expired invite", "status": "active"}, owner["token"])
        expired_invite = api.rpc("create_tenant_invite", {"p_lease_id": expired_lease["id"], "p_email": None}, owner["token"])
        secret_values.append(expired_invite["code"])
        api.patch("tenant_invites", expired_invite["id"], {"expires_at": "2000-01-01T00:00:00Z"}, admin=True)
        api.denied("POST", "/rest/v1/rpc/claim_tenant_invite", token=tenant_token, body={"invite_code": expired_invite["code"]})
        signed = api.ok("POST", "/storage/v1/object/sign/attachments/" + quote(photo["storage_path"], safe="/"), token=tenant_token, body={"expiresIn": 1})
        signed_path = signed.get("signedURL") or signed.get("signedUrl")
        assert isinstance(signed_path, str)
        signed_url = local_url(urljoin(target["url"] + "/storage/v1/", signed_path.lstrip("/")))
        # Preserve the actual signed target returned by Storage without logging it.
        if signed_path.startswith("/object/"):
            signed_url = target["url"] + "/storage/v1" + signed_path
        elif signed_path.startswith("/storage/v1/"):
            signed_url = target["url"] + signed_path
        secret_values.append(urlparse(signed_url).query)
        owner_page.goto(base + "/lease/" + lease["id"], wait_until="domcontentloaded")
        owner_page.get_by_role("button", name="Remove portal access", exact=True).click()
        wait_for_data(lambda: api.select("leases", owner["token"], id=lease["id"])[0]["tenant_user_id"] is None)
        assert api.select("maintenance_requests", tenant_token, id=request_id) == []
        assert api.select("request_messages", tenant_token, request_id=request_id) == []
        assert api.select("request_photos", tenant_token, request_id=request_id) == []
        api.denied("GET", "/storage/v1/object/authenticated/attachments/" + quote(photo["storage_path"], safe="/"), token=tenant_token, statuses=(400, 403, 404), codes=None)
        api.denied("POST", "/storage/v1/object/sign/attachments/" + quote(photo["storage_path"], safe="/"), token=tenant_token, body={"expiresIn": 60}, statuses=(400, 403, 404), codes=None)
        api.denied("POST", "/rest/v1/rpc/reopen_tenant_request", token=tenant_token, body={"p_request_id": request_id, "p_reason": "Must be refused after unlink"})
        time.sleep(2)
        try:
            response = api.http.open(Request(signed_url, headers={"Cache-Control": "no-cache"}), timeout=12)
            signed_status = response.status
            response.close()
        except HTTPError as failure:
            signed_status = failure.code
        assert 400 <= signed_status < 500, "A short-lived signed URL remained valid beyond its expiry."
        tenant_page.reload(wait_until="domcontentloaded")
        expect(tenant_page.get_by_text("This request is unavailable or portal access has been removed.", exact=True)).to_be_visible()
        checkpoint("expired invites are refused; unlink revokes future rows/objects/signing and issued URLs expire")

        assert not result["blocked_requests"], "Unexpected non-loopback browser traffic was blocked."
        assert not result["page_errors"], "Browser runtime errors were observed."
        for label, page in [("owner", owner_page), ("tenant", tenant_page)]:
            screenshot = args.output / (label + "-final.png")
            page.screenshot(path=str(screenshot), full_page=True)
            protect_file(screenshot)
        result["status"] = "passed"
        checkpoint("no browser runtime errors or external HTTP/WebSocket traffic")
    except Exception as failure:
        result["status"] = "failed"
        result["failure"] = {"step": current_step, "error": clean(failure)}
        result["failure"]["pending_http"] = [{"method": value["method"], "host": value["host"], "path": value["path"], "elapsed_seconds": round(time.monotonic() - value["started"], 2)} for value in pending_http.values()]
        result["failure"]["pages"] = []
        for index, context in enumerate(contexts):
            for page_index, page in enumerate(context.pages):
                try:
                    page_failure = {"context": index, "page": page_index, "url": clean(page.url), "visible_text": clean(page.locator("body").inner_text(timeout=3000))[:2000]}
                    result["failure"]["pages"].append(page_failure)
                    page_failure["saved_operations"] = page.evaluate("""() => Object.keys(localStorage)
                        .filter(key => key.startsWith('rentview.offline.queue.v2.'))
                        .flatMap(key => { try { return JSON.parse(localStorage.getItem(key)).map(op => ({id: op.id, accountId: op.accountId, kind: op.kind, table: op.table, status: op.status, attempts: op.attempts})); } catch { return [{unreadable: true}]; } })""")
                    page_failure["web_locks"] = page.evaluate("""async () => {
                        if (!navigator.locks) return {supported: false};
                        const locks = await navigator.locks.query();
                        return {held: locks.held.map(lock => ({name: lock.name, mode: lock.mode})), pending: locks.pending.map(lock => ({name: lock.name, mode: lock.mode}))};
                    }""")
                    screenshot = args.output / f"failure-{index}-{page_index}.png"
                    page.screenshot(path=str(screenshot), full_page=True, timeout=5000)
                    protect_file(screenshot)
                except Exception:
                    pass
    finally:
        for context in contexts:
            try:
                context.close()
            except Exception:
                pass
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        if playwright:
            try:
                playwright.stop()
            except Exception:
                pass
        if not args.keep_fixtures:
            cleanup_errors = 0
            # Query only this run's principals so a successful upload followed by
            # a failed metadata write cannot leave an untracked orphan behind.
            owned_paths = {("attachments", path) for path in fixture_paths}
            for user_id in fixture_users:
                try:
                    rows = api.ok("POST", "/rest/v1/rpc/owned_storage_paths", admin=True, body={"p_owner_id": user_id, "p_limit": 1000})
                    owned_paths.update((row["bucket_id"], row["name"]) for row in rows)
                except Exception:
                    cleanup_errors += 1
            for bucket, path in owned_paths:
                try:
                    api.ok("DELETE", "/storage/v1/object/" + quote(bucket, safe=""), admin=True, body={"prefixes": [path]})
                except Exception:
                    cleanup_errors += 1
            for user_id in reversed(fixture_users):
                try:
                    api.ok("DELETE", "/auth/v1/admin/users/" + user_id, admin=True)
                except Exception:
                    cleanup_errors += 1
            result["cleanup"] = {"own_synthetic_users": len(fixture_users), "errors": cleanup_errors}
            if cleanup_errors:
                result["status"] = "failed"
                result.setdefault("failure", {"step": "fixture_cleanup", "error": "Synthetic fixture cleanup was incomplete; see cleanup error count."})
        else:
            result["cleanup"] = {"retained": True, "synthetic_users": len(fixture_users)}
        result["page_errors"] = [clean(value) for value in result["page_errors"]]
        output = args.output / "results.json"
        output.write_text(json.dumps(result, indent=2))
        protect_file(output)
        print(json.dumps({"status": result["status"], "checks": len(result["checks"]), "failure": result.get("failure"), "result_file": str(output)}, indent=2), flush=True)
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    def timeout(_signal, _frame):
        raise TimeoutError("Local E2E wall-clock limit reached.")
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(420)
    raise SystemExit(main())
