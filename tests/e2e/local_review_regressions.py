"""Bounded PR-review regressions against disposable local Supabase and web UI.

Auth, tenancy, messages, storage and successful retries use real local services.
Only the first creation response is deliberately rejected at the browser boundary
to exercise failed-save recovery. No authentication/queue state is injected.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import signal
from urllib.parse import quote, urlencode, urlparse
from uuid import uuid4

from local_e2e import LOOPBACK, PNG, LocalAPI, local_url, private_credentials, protect_file


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--credentials-file", required=True, type=Path)
    parser.add_argument("--allow-disposable-local", action="store_true")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--browser", default="/usr/bin/chromium")
    parser.add_argument("--check-target", action="store_true")
    args = parser.parse_args(argv)
    if not args.allow_disposable_local:
        parser.error("Explicit disposable-local opt-in required; no service contacted.")
    try:
        base = local_url(args.base_url, root=True)
        target = private_credentials(args.credentials_file)
    except (ValueError, OSError, json.JSONDecodeError) as failure:
        parser.error(str(failure))
    if args.check_target:
        print(json.dumps({"target": "loopback only", "contacted": False}))
        return 0
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    result_path = args.output / "results.json"
    descriptor = os.open(result_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    secret_values = [target["anon"], target["service"]]
    api = LocalAPI(target, secret_values)
    result = {"status": "running", "scope": "synthetic local browser/Auth/API/Storage; first-create rejection injected, retry real", "checks": [], "page_errors": [], "blocked_requests": [], "not_run": ["physical devices", "external providers", "45-second link expiry browser timing (unit regression separate)"]}
    users, contexts, paths = [], [], []
    playwright = browser = None
    run_id = uuid4().hex[:12]
    # Private evidence identifies exactly this run's disposable fixtures if a
    # cleanup operation fails; never include passwords, tokens or signed URLs.
    result["fixtures"] = {"run_id": run_id, "user_ids": users}
    step = "initialization"
    signatures, message_reads, create_posts = [], [], []
    dialogs = []

    def clean(value):
        value = str(value)
        for secret in sorted(secret_values, key=len, reverse=True):
            value = value.replace(secret, "[fixture-secret]")
        return re.sub(r"eyJ[A-Za-z0-9_.-]{30,}", "[token]", value)

    def save():
        result_path.write_text(json.dumps(result, indent=2) + "\n")
        protect_file(result_path)

    def checkpoint(name, **evidence):
        result["checks"].append({"name": name, **evidence})
        save()
        print(json.dumps({"passed": name}), flush=True)

    def principal(label):
        email = f"rentview-review-{run_id}-{label}@example.test"
        password = "Rv!" + secrets.token_urlsafe(24)
        secret_values.append(password)
        uid = api.admin_user(email, password, "Fixture review " + label)
        users.append(uid)
        login_id, token = api.login(email, password)
        assert uid == login_id
        return {"id": uid, "email": email, "password": password, "token": token}

    def linked_lease(landlord, tenant, property_name):
        prop = api.insert("properties", {"owner_id": landlord["id"], "name": property_name, "currency": "USD"}, landlord["token"])
        unit = api.insert("units", {"owner_id": landlord["id"], "property_id": prop["id"], "label": "Review unit"}, landlord["token"])
        lease = api.insert("leases", {"owner_id": landlord["id"], "unit_id": unit["id"], "tenant_name": "Review linked tenant", "status": "active"}, landlord["token"])
        invitation = api.rpc("create_tenant_invite", {"p_lease_id": lease["id"], "p_email": tenant["email"]}, landlord["token"])
        if isinstance(invitation, list):
            invitation = invitation[0]
        api.rpc("claim_tenant_invite", {"invite_code": invitation["code"]}, tenant["token"])
        return prop, unit, lease

    def repair(landlord, tenant, prop, unit, lease, title):
        return api.insert("maintenance_requests", {"owner_id": landlord["id"], "tenant_user_id": tenant["id"], "property_id": prop["id"], "unit_id": unit["id"], "lease_id": lease["id"], "title": title}, tenant["token"])

    def operations(page, account_id):
        return page.evaluate("uid => JSON.parse(localStorage.getItem('rentview.offline.queue.v2.' + uid) || '[]')", account_id)

    try:
        from playwright.sync_api import expect, sync_playwright
        owner, landlord, tenant = principal("dual-owner"), principal("landlord"), principal("tenant")
        # Give the dual principal a property before claiming a tenancy, preserving
        # its owner role through the real claim operation.
        prop, unit, lease = linked_lease(owner, tenant, "Review own portfolio")
        rented_prop, rented_unit, rented_lease = linked_lease(landlord, owner, "Review rented elsewhere")
        own_title, foreign_title = "Review owned repair " + run_id, "Review rented repair " + run_id
        own = repair(owner, tenant, prop, unit, lease, own_title)
        rented = repair(landlord, owner, rented_prop, rented_unit, rented_lease, foreign_title)
        assert api.select("profiles", owner["token"], id=owner["id"])[0]["role"] == "owner"
        assert {row["id"] for row in api.select("maintenance_requests", owner["token"])} == {own["id"], rented["id"]}, "Fixture must demonstrate both rows are permitted by RLS"
        good_path = f"requests/{own['id']}/{uuid4()}.png"
        paths.append(("attachments", good_path))
        api.ok("POST", "/storage/v1/object/attachments/" + good_path, token=tenant["token"], body=PNG, headers={"Content-Type": "image/png"})
        api.insert("request_photos", {"request_id": own["id"], "storage_path": good_path}, tenant["token"])
        # A valid record pointing to an unavailable object reproduces legacy file
        # deletion without changing any security policy or using malformed paths.
        missing_path = f"requests/{own['id']}/{uuid4()}.png"
        api.insert("request_photos", {"request_id": own["id"], "storage_path": missing_path}, tenant["token"])
        message = "Review conversation remains readable " + run_id
        api.insert("request_messages", {"request_id": own["id"], "sender_id": tenant["id"], "body": message}, tenant["token"])
        spare_unit = api.insert("units", {"owner_id": owner["id"], "property_id": prop["id"], "label": "Review empty lease unit"}, owner["token"])
        playwright = sync_playwright().start()
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True, args=["--no-sandbox", "--disable-background-networking"])
        context = browser.new_context(viewport={"width": 1280, "height": 1000}, locale="en-US", service_workers="block")
        contexts.append(context)
        def guard(route):
            parsed = urlparse(route.request.url)
            if parsed.scheme in {"data", "blob"} or parsed.hostname in LOOPBACK:
                if parsed.path.startswith("/storage/v1/object/sign/attachments/") and route.request.method == "POST":
                    signatures.append(parsed.path)
                if parsed.path == "/rest/v1/request_messages" and route.request.method == "GET":
                    message_reads.append(parsed.path)
                route.continue_()
            else:
                result["blocked_requests"].append({"host": parsed.hostname, "path": parsed.path})
                route.abort("blockedbyclient")
        context.route("**/*", guard)
        if not hasattr(context, "route_web_socket"):
            raise RuntimeError("WebSocket interception unavailable; browser checks not run")
        def guard_ws(route):
            parsed = urlparse(route.url)
            if parsed.hostname in LOOPBACK:
                route.connect_to_server()
            else:
                result["blocked_requests"].append({"host": parsed.hostname, "path": parsed.path, "kind": "websocket"})
                route.close()
        context.route_web_socket("**/*", guard_ws)
        page = context.new_page()
        page.set_default_timeout(15_000)
        page.on("pageerror", lambda error: result["page_errors"].append(clean(error)))
        def accept_dialog(dialog):
            dialogs.append(clean(dialog.message))
            dialog.accept()
        page.on("dialog", accept_dialog)
        page.goto(base + "/login", wait_until="domcontentloaded")
        page.get_by_label("Email", exact=True).fill(owner["email"])
        page.get_by_label("Password", exact=True).fill(owner["password"])
        page.get_by_role("button", name="Sign in", exact=True).click()
        expect(page.get_by_role("button", name="Open Work", exact=True)).to_be_visible(timeout=25_000)
        step = "owner scope across dashboard and inbox"
        expect(page.get_by_text("1 new tenant requests to triage", exact=True)).to_be_visible()
        expect(page.get_by_text("2 new tenant requests to triage", exact=True)).to_have_count(0)
        page.goto(base + "/requests", wait_until="domcontentloaded")
        expect(page.get_by_text(own_title, exact=True)).to_be_visible()
        expect(page.get_by_text(foreign_title, exact=True)).to_have_count(0)
        page.goto(base + "/request/" + rented["id"], wait_until="domcontentloaded")
        expect(page.get_by_text("Request unavailable", exact=True)).to_be_visible()
        expect(page.get_by_text(foreign_title, exact=True)).to_have_count(0)
        page.goto(base + "/tenant/request/" + rented["id"], wait_until="domcontentloaded")
        expect(page.get_by_text(foreign_title, exact=True)).to_be_visible()
        checkpoint("owner also renting elsewhere sees only owned requests in owner dashboard/inbox/detail, while tenant portal remains usable")

        step = "independent photo failure and polling cache"
        signature_start = len(signatures)
        page.goto(base + "/request/" + own["id"], wait_until="domcontentloaded")
        expect(page.get_by_text(message, exact=True)).to_be_visible()
        expect(page.get_by_role("button", name=re.compile(r"^Open repair photo \d+$"))).to_have_count(1)
        expect(page.get_by_text("Photo unavailable. Refresh to retry.", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="Retry unavailable photos", exact=True)).to_be_visible()
        initial_signatures = signatures[signature_start:]
        result["photo_links"] = {"initial_signing_post_count": len(initial_signatures)}
        assert len(initial_signatures) == 2, f"Initial photo links were not resolved once each ({len(initial_signatures)} signing POSTs)"
        before_poll = len(message_reads)
        with page.expect_response(lambda response: response.request.method == "GET" and urlparse(response.url).path == "/rest/v1/request_messages", timeout=20_000):
            page.wait_for_timeout(13_000)
        assert len(message_reads) > before_poll, "No actual conversation refresh occurred"
        assert signatures[signature_start:] == initial_signatures, "The12-second poll re-signed unexpired links"
        expect(page.get_by_text(message, exact=True)).to_be_visible()
        checkpoint("one missing photo preserves message/valid-photo display and actual12-second polling reuses existing links", initial_signatures=2, extra_signatures_during_poll=0)
        page.get_by_role("button", name="Retry unavailable photos", exact=True).click()
        page.wait_for_function("() => !document.querySelector('[aria-label=\"Loading conversation\"]')")
        # Wait for the actual missing-object request, rather than assuming that
        # clicking the button completed its asynchronous refresh.
        deadline = __import__("time").monotonic() + 12
        while len(signatures) == signature_start + 2:
            assert __import__("time").monotonic() < deadline, "Explicit unavailable-photo retry did not reach Storage"
            page.wait_for_timeout(50)
        assert len(signatures) == signature_start + 3 and signatures[-1].endswith(missing_path)
        expect(page.get_by_text(message, exact=True)).to_be_visible()
        checkpoint("explicit photo retry touches only the unavailable object and preserves the conversation")

        def failed_creation(table, route_path, label, value, *, lease_form=False):
            nonlocal step
            step = table + " repeated failed creation"
            assert operations(page, owner["id"]) == []
            rejected_posts = []
            def reject_create(route):
                parsed = urlparse(route.request.url)
                assert parsed.hostname in LOOPBACK
                if route.request.method != "POST":
                    route.continue_()
                    return
                payload = route.request.post_data_json
                payload = payload[0] if isinstance(payload, list) else payload
                rejected_posts.append(payload)
                create_posts.append({"table": table, "id": payload["id"], "stage": "injected-domain-rejection"})
                route.fulfill(status=409, content_type="application/json", body=json.dumps({"code": "23514", "message": "Disposable review failure; correct the saved change and retry."}))
            route_match = "**/rest/v1/" + table + "*"
            page.route(route_match, reject_create)
            page.goto(base + route_path, wait_until="domcontentloaded")
            if lease_form:
                page.get_by_text("Lease & tenant", exact=True).locator("..").get_by_text("Add", exact=True).click()
            page.get_by_label(label, exact=True).fill(value)
            page.get_by_role("button", name="Save", exact=True).click()
            page.wait_for_function("uid => JSON.parse(localStorage.getItem('rentview.offline.queue.v2.'+uid)||'[]').some(row=>row.status==='failed')", arg=owner["id"])
            expect(page.get_by_role("button", name="Save", exact=True)).to_be_enabled()
            first = operations(page, owner["id"])
            assert len(first) == 1 and first[0]["table"] == table and len(rejected_posts) == 1
            page.get_by_role("button", name="Save", exact=True).click()
            expect(page.get_by_role("button", name="Save", exact=True)).to_be_enabled()
            assert operations(page, owner["id"]) == first and len(rejected_posts) == 1, "Repeated Save changed or forked the durable operation"
            expect(page.get_by_label(label, exact=True)).to_have_value(value)
            page.get_by_role("button", name="Cancel", exact=True).click()
            expect(page.get_by_role("dialog")).to_have_count(0)
            page.unroute(route_match, reject_create)
            assert api.select(table, owner["token"], id=first[0]["id"]) == []
            page.goto(base + "/sync", wait_until="domcontentloaded")
            expect(page.get_by_text(value, exact=True)).to_be_visible()
            page.get_by_role("button", name="Edit details", exact=True).click()
            edited = value + " corrected"
            page.get_by_label(label, exact=True).fill(edited)
            if lease_form:
                expect(page.get_by_label("Rent amount", exact=True)).to_have_value("")
                expect(page.get_by_label("Deposit", exact=True)).to_have_value("")
                page.get_by_label("Deposit", exact=True).fill("12.345")
                before = operations(page, owner["id"])
                page.get_by_role("button", name="Save and retry", exact=True).click()
                expect(page.get_by_role("button", name="Save and retry", exact=True)).to_be_enabled()
                expect(page.get_by_label("Deposit", exact=True)).to_have_value("12.345")
                assert operations(page, owner["id"]) == before, "Invalid precision changed the saved payload"
                assert "at most two decimal places" in dialogs[-1]
                page.get_by_label("Deposit", exact=True).fill("")
            with page.expect_response(lambda response: response.request.method == "POST" and urlparse(response.url).path == "/rest/v1/" + table) as retried:
                page.get_by_role("button", name="Save and retry", exact=True).click()
            assert retried.value.status == 201, "Corrected saved change was not committed by the real local API"
            expect(page.get_by_role("dialog")).to_have_count(0)
            expect(page.get_by_text("No changes waiting to sync.", exact=True)).to_be_visible()
            rows = api.select(table, owner["token"], id=first[0]["id"])
            field = {"work_orders": "title", "assets": "name", "leases": "tenant_name"}[table]
            assert len(rows) == 1 and rows[0][field] == edited
            matches = api.select(table, owner["token"], **{field: edited})
            assert len(matches) == 1 and matches[0]["id"] == first[0]["id"]
            if lease_form:
                assert rows[0]["rent_amount"] is None and rows[0]["deposit_amount"] is None
            checkpoint(table + " failed Save/repeated Save/edit/real retry retains one ID and commits exactly once", injected_failures=len(rejected_posts), real_retry_status=201, nullable_money_and_precision=lease_form)

        failed_creation("work_orders", "/work-orders?" + urlencode({"new": "1", "propertyId": prop["id"]}), "Title", "Review failed work order " + run_id)
        failed_creation("assets", "/assets?" + urlencode({"new": "1", "propertyId": prop["id"]}), "Name", "Review failed asset " + run_id)
        failed_creation("leases", "/unit/" + spare_unit["id"], "Tenant name", "Review failed lease " + run_id, lease_form=True)
        assert not result["page_errors"] and not result["blocked_requests"]
        checkpoint("no browser runtime errors or external HTTP/WebSocket requests")
        result["status"] = "passed"
    except Exception as failure:
        result["status"] = "failed"
        result["failure"] = {"step": step, "type": type(failure).__name__, "message": clean(failure)[:1800]}
    finally:
        for context in contexts:
            try:
                context.close()
            except Exception:
                pass
        if browser:
            browser.close()
        if playwright:
            playwright.stop()
        cleanup = [api.cleanup_synthetic_user(uid) for uid in reversed(users)]
        cleanup_errors = sum(item["status"] != "deleted" for item in cleanup)
        result["cleanup"] = {"synthetic_users": len(users), "storage_objects": sum(item["removed_objects"] for item in cleanup), "errors": cleanup_errors, "details": cleanup}
        if cleanup_errors:
            result["status"] = "failed"
        save()
        print(json.dumps({"status": result["status"], "checks": len(result["checks"]), "failure": result.get("failure"), "report": str(result_path)}), flush=True)
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    def timeout(_signal, _frame):
        raise TimeoutError("Local review regression wall-clock limit reached")
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(165)
    raise SystemExit(main())
