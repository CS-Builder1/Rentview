"""Bounded finance browser/Data API checks on an explicitly disposable backend.

Uses synthetic identities, real CSV downloads and real rejected/committed writes.
Every browser HTTP/WebSocket destination is restricted to loopback. No provider,
hosted endpoint or physical-device behavior is exercised.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
from decimal import Decimal
import io
import json
import os
from pathlib import Path
import re
import secrets
import signal
from urllib.parse import parse_qs, urlencode, urlparse
from uuid import uuid4
from zoneinfo import ZoneInfo

from local_e2e import LOOPBACK, LocalAPI, local_url, private_credentials, protect_file


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
    result = {"status": "running", "scope": "real local browser/Auth/Data API/CSV; synthetic identities only", "checks": [], "page_errors": [], "blocked_requests": [], "dialogs": [], "not_run": ["native sharing and device timezone", "external accountant applications", "full finance policy audit"]}
    users, contexts = [], []
    playwright = browser = None
    run_id = uuid4().hex[:12]
    step = "initialization"
    year = dt.datetime.now(ZoneInfo("America/Los_Angeles")).year
    expense_requests = []

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
        email = f"rentview-finance-{run_id}-{label}@example.test"
        password = "Rv!" + secrets.token_urlsafe(24)
        secret_values.append(password)
        uid = api.admin_user(email, password, "Fixture finance " + label)
        users.append(uid)
        login_id, token = api.login(email, password)
        assert login_id == uid
        return {"id": uid, "email": email, "password": password, "token": token}

    def make_page(zone):
        context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="en-US", timezone_id=zone, service_workers="block", accept_downloads=True)
        contexts.append(context)
        def guard(route):
            parsed = urlparse(route.request.url)
            if parsed.scheme in {"data", "blob"} or parsed.hostname in LOOPBACK:
                if parsed.path == "/rest/v1/expenses":
                    expense_requests.append({"method": route.request.method, "query": parse_qs(parsed.query)})
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
        page.set_default_timeout(25_000)
        page.on("pageerror", lambda error: result["page_errors"].append(clean(error)))
        def dialog(value):
            result["dialogs"].append(clean(value.message))
            value.accept()
        page.on("dialog", dialog)
        return page

    def login(page, who):
        page.goto(base + "/login", wait_until="domcontentloaded")
        page.get_by_label("Email", exact=True).fill(who["email"])
        page.get_by_label("Password", exact=True).fill(who["password"])
        page.get_by_role("button", name="Sign in", exact=True).click()
        page.wait_for_url(lambda value: urlparse(value).path.rstrip("/") != "/login", timeout=30_000)
        expect(page.get_by_role("button", name="Open Work", exact=True)).to_be_visible(timeout=30_000)

    def download(page, label):
        with page.expect_download(timeout=30_000) as pending:
            page.get_by_role("button", name="Export CSV", exact=True).click()
        value = pending.value
        path = args.output / (label + ".csv")
        value.save_as(path)
        protect_file(path)
        with path.open(newline="", encoding="utf-8-sig") as stream:
            rows = list(csv.reader(stream))
        assert rows[0] == ["Date", "Property", "Unit", "Category", "Description", "Vendor", "Amount", "Currency"]
        body, totals = [], {}
        for row in rows[1:]:
            if not row:
                continue
            assert len(row) == 8
            if row[5].startswith("Total ("):
                assert row[7] not in totals, "Duplicate currency total"
                totals[row[7]] = Decimal(row[6])
            else:
                body.append(row)
        assert not any("Foreign finance sentinel" in " ".join(row) for row in body), "Export included another owner's expense"
        return body, totals

    try:
        from playwright.sync_api import expect, sync_playwright
        owner, outsider = principal("owner"), principal("other-owner")
        prop = api.insert("properties", {"owner_id": owner["id"], "name": "=Finance formula property", "currency": "USD"}, owner["token"])
        separate = api.insert("properties", {"owner_id": owner["id"], "name": "Finance Separate", "currency": "EUR"}, owner["token"])
        unit = api.insert("units", {"owner_id": owner["id"], "property_id": prop["id"], "label": "+Finance unit"}, owner["token"])
        vendor = api.insert("vendors", {"owner_id": owner["id"], "name": "@Finance vendor"}, owner["token"])
        def expense(description, amount, currency="USD", date=None, property_id=None, links=False):
            return {"id": str(uuid4()), "owner_id": owner["id"], "property_id": property_id or prop["id"], "incurred_on": date or f"{year}-01-31", "amount": amount, "currency": currency, "category": "repair", "description": description, "unit_id": unit["id"] if links else None, "vendor_id": vendor["id"] if links else None}
        seeded = [expense(f"Finance penny {index:04d}", "0.01") for index in range(1003)]
        formula = expense('=SUM(1,2)\nFixture, "quoted"', "0.10", links=True)
        seeded.extend([formula, expense("Finance exact twenty cents", "0.20"), expense("Finance XCD receipt", "100.00", "XCD"), expense("Finance EUR receipt", "5.25", "EUR", property_id=separate["id"]), expense("Finance prior-year receipt", "7.50", date=f"{year - 1}-12-31"), expense("Finance leap receipt", "9.99", date="2024-02-29")])
        assert year > 2025, "Fixture date assumptions require review for this year"
        status, _ = api.request("POST", "/rest/v1/expenses", token=owner["token"], body=seeded, headers={"Prefer": "return=minimal"})
        assert status == 201, "Synthetic finance batch insert failed"
        api.insert("expenses", {"owner_id": outsider["id"], "amount": "999.99", "currency": "EUR", "description": "Foreign finance sentinel", "incurred_on": f"{year}-01-31"}, outsider["token"])
        playwright = sync_playwright().start()
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True, args=["--no-sandbox", "--disable-background-networking"])
        page = make_page("America/Los_Angeles")
        login(page, owner)
        step = "finance summary currency separation"
        page.goto(base + "/expenses", wait_until="domcontentloaded")
        expect(page.get_by_text("Spend this year", exact=True)).to_be_visible()
        for value in ["$10.33", "EC$100.00", "€5.25"]:
            expect(page.get_by_text(value, exact=True).first).to_be_visible()
        checkpoint("year-to-date UI keeps USD, XCD and EUR separate with exact cent totals")

        step = "current-year full CSV and escaping"
        page.goto(base + "/export", wait_until="domcontentloaded")
        expect(page.get_by_role("button", name="Export CSV", exact=True)).to_be_visible()
        start = len(expense_requests)
        body, totals = download(page, "this-year")
        assert len(body) == 1007 and totals == {"USD": Decimal("10.33"), "XCD": Decimal("100.00"), "EUR": Decimal("5.25")}
        offsets = sorted({int(value["query"].get("offset", ["0"])[0]) for value in expense_requests[start:] if value["method"] == "GET"})
        assert offsets == [0, 250, 500, 750, 1000], "CSV did not page completely beyond the API row cap"
        escaped = [row for row in body if "SUM(1,2)" in row[4]]
        assert len(escaped) == 1 and escaped[0][0] == f"{year}-01-31"
        assert escaped[0][1] == "'=Finance formula property" and escaped[0][2] == "'+Finance unit" and escaped[0][5] == "'@Finance vendor"
        assert escaped[0][4] == "'" + formula["description"]
        checkpoint("actual CSV includes all1007 current-year rows over five pages and escapes formula/quoted/newline text", csv_rows=len(body), offsets=offsets)

        step = "CSV period and property filters"
        page.get_by_text("Last year", exact=True).click()
        body, totals = download(page, "last-year")
        assert len(body) == 1 and body[0][0] == f"{year - 1}-12-31" and totals == {"USD": Decimal("7.50")}
        page.get_by_text("All time", exact=True).click()
        body, totals = download(page, "all-time")
        assert len(body) == 1009 and totals == {"USD": Decimal("27.82"), "XCD": Decimal("100.00"), "EUR": Decimal("5.25")}
        page.get_by_text("Finance Separate", exact=True).click()
        body, totals = download(page, "single-property")
        assert len(body) == 1 and body[0][1] == "Finance Separate" and totals == {"EUR": Decimal("5.25")}
        checkpoint("CSV current/prior/all periods and property filters retain dates, currency totals and owner isolation")

        step = "leap and end-month browser dates"
        page.goto(base + "/expenses", wait_until="domcontentloaded")
        leap = page.get_by_text("Finance leap receipt", exact=True).locator("xpath=ancestor::*[@role='button'][1]")
        expect(leap.get_by_text("Feb 29, 2024", exact=True)).to_be_visible()
        leap.click()
        expect(page.get_by_label("Expense date (YYYY-MM-DD)", exact=True)).to_have_value("2024-02-29")
        page.get_by_label("Expense date (YYYY-MM-DD)", exact=True).fill("2024-03-31")
        page.get_by_role("button", name="Save", exact=True).click()
        expect(page.get_by_role("dialog")).to_have_count(0)
        leap_row = next(row for row in seeded if row["description"] == "Finance leap receipt")
        assert api.select("expenses", owner["token"], id=leap_row["id"])[0]["incurred_on"] == "2024-03-31"
        expect(page.get_by_text("Finance leap receipt", exact=True).locator("xpath=ancestor::*[@role='button'][1]").get_by_text("Mar 31, 2024", exact=True)).to_be_visible()
        atlantic = make_page("America/St_Lucia")
        login(atlantic, owner)
        atlantic.goto(base + "/expenses", wait_until="domcontentloaded")
        atlantic.get_by_text("Finance leap receipt", exact=True).click()
        expect(atlantic.get_by_label("Expense date (YYYY-MM-DD)", exact=True)).to_have_value("2024-03-31")
        atlantic.get_by_role("button", name="Cancel", exact=True).click()
        expect(atlantic.get_by_role("dialog")).to_have_count(0)
        checkpoint("leap-day and end-month receipt edits retain their exact calendar day in Pacific and Atlantic browser timezones")

        step = "rejected posted edit preserves draft"
        job = api.insert("work_orders", {"owner_id": owner["id"], "property_id": prop["id"], "title": "Finance posted job"}, owner["token"])
        posted_id = api.rpc("complete_work_order", {"p_work_order_id": job["id"], "p_labor_amount": 12, "p_currency": "USD", "p_summary": "Finance posted completion"}, owner["token"])
        page.goto(base + "/expenses", wait_until="domcontentloaded")
        page.get_by_text("Finance posted completion", exact=True).click()
        page.get_by_label("Amount", exact=True).fill("44.55")
        page.get_by_label("Expense date (YYYY-MM-DD)", exact=True).fill("2024-12-31")
        page.get_by_label("Description (optional)", exact=True).fill("Finance rejected edit draft")
        with page.expect_response(lambda response: response.request.method == "PATCH" and urlparse(response.url).path == "/rest/v1/expenses") as rejected:
            page.get_by_role("button", name="Save", exact=True).click()
        assert rejected.value.status in (400, 409) and rejected.value.json().get("code") == "23514"
        assert result["dialogs"][-1] == "Could not save\n\n" + rejected.value.json()["message"], "The rejected edit did not show the actionable backend message"
        expect(page.get_by_label("Amount", exact=True)).to_have_value("44.55")
        expect(page.get_by_label("Expense date (YYYY-MM-DD)", exact=True)).to_have_value("2024-12-31")
        expect(page.get_by_label("Description (optional)", exact=True)).to_have_value("Finance rejected edit draft")
        stored = api.select("expenses", owner["token"], id=posted_id)[0]
        assert Decimal(str(stored["amount"])) == Decimal("12") and stored["description"] == "Finance posted completion"
        page.get_by_role("button", name="Cancel", exact=True).click()
        expect(page.get_by_role("dialog")).to_have_count(0)
        checkpoint("actual posted-cost rejection preserves amount/date/description draft and does not change the stored expense")

        step = "failed expense draft repeated-save identity"
        temporary = api.insert("properties", {"owner_id": owner["id"], "name": "Finance disappearing property"}, owner["token"])
        page.goto(base + "/expenses?" + urlencode({"new": "1", "propertyId": temporary["id"]}), wait_until="domcontentloaded")
        page.get_by_label("Amount", exact=True).fill("17.25")
        page.get_by_label("Expense date (YYYY-MM-DD)", exact=True).fill("2024-02-29")
        page.get_by_label("Description (optional)", exact=True).fill("Finance failed create draft")
        deleted, _ = api.request("DELETE", "/rest/v1/properties?id=eq." + temporary["id"], token=owner["token"])
        assert deleted == 204
        page.get_by_role("button", name="Save", exact=True).click()
        expect(page.get_by_label("Description (optional)", exact=True)).to_have_value("Finance failed create draft")
        def operations():
            return page.evaluate("uid => JSON.parse(localStorage.getItem('rentview.offline.queue.v2.'+uid) || '[]')", owner["id"])
        page.wait_for_function("uid => JSON.parse(localStorage.getItem('rentview.offline.queue.v2.'+uid)||'[]').some(row => row.status==='failed')", arg=owner["id"])
        first = operations()
        assert len(first) == 1 and first[0]["payload"]["description"] == "Finance failed create draft"
        page.get_by_role("button", name="Save", exact=True).click()
        expect(page.get_by_role("button", name="Save", exact=True)).to_be_enabled()
        second = operations()
        result["failed_draft_observation"] = {"first_operations": len(first), "after_repeated_save": len(second), "same_ids": [row["id"] for row in first] == [row["id"] for row in second]}
        assert len(second) == 1 and second[0]["id"] == first[0]["id"], "Repeated Save added a second durable expense operation for the same failed draft"
        page.get_by_label("Amount", exact=True).fill("18.50")
        page.get_by_label("Description (optional)", exact=True).fill("Finance unsaved correction draft")
        page.get_by_role("button", name="Save", exact=True).click()
        expect(page.get_by_role("button", name="Save", exact=True)).to_be_enabled()
        unchanged = operations()
        assert len(unchanged) == 1 and unchanged[0]["id"] == first[0]["id"]
        assert unchanged[0]["payload"] == first[0]["payload"], "Editing the form silently replaced a durable failed operation"
        expect(page.get_by_label("Amount", exact=True)).to_have_value("18.50")
        expect(page.get_by_label("Description (optional)", exact=True)).to_have_value("Finance unsaved correction draft")
        checkpoint("repeated Save after real failed creation retains one durable expense identity and all draft fields")
        step = "explicit discard and new expense intent"
        page.get_by_role("button", name="Cancel", exact=True).click()
        expect(page.get_by_role("dialog")).to_have_count(0)
        assert len(operations()) == 1, "Closing a form discarded its durable saved change"
        page.goto(base + "/sync", wait_until="domcontentloaded")
        expect(page.get_by_text("Finance failed create draft", exact=True)).to_be_visible()
        page.get_by_role("button", name="Discard saved change", exact=True).click()
        expect(page.get_by_text("No changes waiting to sync.", exact=True)).to_be_visible()
        page.goto(base + "/expenses?" + urlencode({"new": "1", "propertyId": prop["id"]}), wait_until="domcontentloaded")
        page.get_by_label("Amount", exact=True).fill("17.25")
        page.get_by_label("Expense date (YYYY-MM-DD)", exact=True).fill("2024-02-29")
        page.get_by_label("Description (optional)", exact=True).fill("Finance corrected new intent")
        page.get_by_role("button", name="Save", exact=True).click()
        expect(page.get_by_role("dialog")).to_have_count(0)
        created = api.select("expenses", owner["token"], description="Finance corrected new intent")
        assert len(created) == 1 and created[0]["id"] != first[0]["id"] and Decimal(str(created[0]["amount"])) == Decimal("17.25")
        assert created[0]["incurred_on"] == "2024-02-29" and operations() == []
        assert api.select("expenses", owner["token"], id=first[0]["id"]) == []
        checkpoint("closing preserves the failed operation; explicit discard then new intent creates exactly one correctly dated expense")
        step = "lost committed insert acknowledgement and replay"
        lost = {"posts": 0, "committed_id": None, "first_status": None}
        def lose_first_acknowledgement(route):
            parsed = urlparse(route.request.url)
            assert parsed.hostname in LOOPBACK
            if route.request.method != "POST":
                route.continue_()
                return
            lost["posts"] += 1
            if lost["posts"] != 1:
                route.continue_()
                return
            payload = route.request.post_data_json
            payload = payload[0] if isinstance(payload, list) else payload
            response = route.fetch(max_redirects=0, timeout=12_000)
            lost["first_status"] = response.status
            assert response.status == 201, "The lost acknowledgement probe did not actually commit"
            lost["committed_id"] = payload["id"]
            route.abort("connectionfailed")
        page.route("**/rest/v1/expenses*", lose_first_acknowledgement)
        page.goto(base + "/expenses?" + urlencode({"new": "1", "propertyId": prop["id"]}), wait_until="domcontentloaded")
        page.get_by_label("Amount", exact=True).fill("21.35")
        page.get_by_label("Expense date (YYYY-MM-DD)", exact=True).fill("2024-12-31")
        page.get_by_label("Description (optional)", exact=True).fill("Finance lost acknowledgement")
        page.get_by_role("button", name="Save", exact=True).click()
        expect(page.get_by_role("dialog")).to_have_count(0)
        pending = operations()
        assert lost["first_status"] == 201 and len(pending) == 1 and pending[0]["id"] == lost["committed_id"]
        committed = api.select("expenses", owner["token"], description="Finance lost acknowledgement")
        assert len(committed) == 1 and committed[0]["id"] == lost["committed_id"]
        # A real app reload recovers this pending network operation through the
        # provider's normal automatic replay. Do not race a manual Retry button
        # against an operation which may already be resolving automatically.
        page.goto(base + "/sync", wait_until="domcontentloaded")
        expect(page.get_by_text("No changes waiting to sync.", exact=True)).to_be_visible()
        assert lost["posts"] == 2 and operations() == []
        page.reload(wait_until="domcontentloaded")
        expect(page.get_by_text("No changes waiting to sync.", exact=True)).to_be_visible()
        committed = api.select("expenses", owner["token"], description="Finance lost acknowledgement")
        assert len(committed) == 1 and committed[0]["id"] == lost["committed_id"]
        assert Decimal(str(committed[0]["amount"])) == Decimal("21.35") and committed[0]["incurred_on"] == "2024-12-31"
        result["lost_acknowledgement"] = lost
        checkpoint("a genuinely committed insert with lost browser response automatically replays the same ID after reload as exactly one expense")
        assert not result["page_errors"] and not result["blocked_requests"]
        checkpoint("no browser runtime errors or external HTTP/WebSocket traffic")
        result["status"] = "passed"
    except Exception as failure:
        result["status"] = "failed"
        result["failure"] = {"step": step, "type": type(failure).__name__, "message": clean(failure)[:1800]}
        for index, context in enumerate(contexts):
            for page in context.pages:
                if not page.is_closed():
                    try:
                        (args.output / f"failure-{index}.txt").write_text(clean(page.locator("body").inner_text())[:18000])
                        protect_file(args.output / f"failure-{index}.txt")
                    except Exception:
                        pass
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
        errors = 0
        for uid in reversed(users):
            try:
                status, _ = api.request("DELETE", "/auth/v1/admin/users/" + uid, admin=True)
                assert status == 200
            except Exception:
                errors += 1
        result["cleanup"] = {"synthetic_users": len(users), "errors": errors}
        if errors:
            result["status"] = "failed"
        save()
        print(json.dumps({"status": result["status"], "checks": len(result["checks"]), "failure": result.get("failure"), "report": str(result_path)}), flush=True)
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    def timeout(_signal, _frame):
        raise TimeoutError("Local finance wall-clock limit reached")
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(360)
    raise SystemExit(main())
