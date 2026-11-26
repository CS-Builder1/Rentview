"""Exercise portfolio delegation, leasing, rent and building history through a real local browser."""
from __future__ import annotations

import argparse
import csv
from datetime import date, timedelta
import json
import os
from pathlib import Path
import re
import secrets
from urllib.parse import quote, urlparse
from uuid import uuid4

from local_e2e import LOOPBACK, LocalAPI, local_url, private_credentials, protect_file


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--credentials-file", required=True, type=Path)
    parser.add_argument("--allow-disposable-local", action="store_true")
    parser.add_argument("--browser", default="/usr/bin/chromium")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--check-target", action="store_true")
    args = parser.parse_args(argv)
    if not args.allow_disposable_local:
        parser.error("A disposable local target must be explicitly selected.")
    try:
        base = local_url(args.base_url, root=True)
        target = private_credentials(args.credentials_file)
    except (ValueError, OSError) as failure:
        parser.error(str(failure))
    if args.check_target:
        print(json.dumps({"target": "loopback only", "contacted": False}))
        return 0

    from playwright.sync_api import expect, sync_playwright

    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    report_file = args.output / "results.json"
    with report_file.open("x") as report:
        report.write("{}")
    run_id = uuid4().hex[:12]
    hidden = [target["service"], target["anon"]]
    api = LocalAPI(target, hidden)
    users, contexts = [], []
    result = {"status": "running", "run_id": run_id, "checks": [], "actors": users,
              "page_errors": [], "blocked_requests": []}
    active = "startup"
    playwright = browser = None

    def safe(value):
        text = str(value)
        for secret in sorted(hidden, key=len, reverse=True):
            text = text.replace(secret, "[private]")
        return re.sub(r"eyJ[A-Za-z0-9_.-]{30,}", "[token]", text)

    def save():
        report_file.write_text(json.dumps(result, indent=2) + "\n")
        protect_file(report_file)

    def checkpoint(name, **evidence):
        result["checks"].append({"name": name, **evidence})
        save()
        print(json.dumps({"passed": name}), flush=True)

    def principal(label):
        email = f"rentview-records-{run_id}-{label}@example.test"
        password = "Rv!" + secrets.token_urlsafe(24)
        hidden.append(password)
        uid = api.admin_user(email, password, "Records fixture " + label)
        users.append(uid)
        authenticated, token = api.login(email, password)
        assert authenticated == uid
        return {"id": uid, "email": email, "password": password, "token": token}

    def sign_in(person):
        context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="en-US",
                                      timezone_id="UTC", service_workers="block", accept_downloads=True)
        contexts.append(context)

        def guard(route):
            address = urlparse(route.request.url)
            if address.scheme in ("blob", "data") or address.hostname in LOOPBACK:
                route.continue_()
            else:
                result["blocked_requests"].append(address.hostname)
                route.abort("blockedbyclient")

        def guard_ws(route):
            address = urlparse(route.url)
            if address.hostname in LOOPBACK:
                route.connect_to_server()
            else:
                result["blocked_requests"].append(address.hostname)
                route.close()

        context.route("**/*", guard)
        context.route_web_socket("**/*", guard_ws)
        page = context.new_page()
        page.set_default_timeout(15_000)
        page.on("pageerror", lambda error: result["page_errors"].append(safe(error)))
        page.on("dialog", lambda dialog: dialog.accept())
        go(page, "/login")
        page.get_by_label("Email", exact=True).fill(person["email"])
        page.get_by_label("Password", exact=True).fill(person["password"])
        button(page, "Sign in").click()
        page.wait_for_url(lambda url: urlparse(url).path.rstrip("/") != "/login")
        return page

    def go(page, path):
        page.goto(base + path, wait_until="domcontentloaded")

    def button(page, name):
        return page.get_by_role("button", name=name, exact=True)

    def field(page, name, text):
        page.get_by_label(name, exact=True).fill(text)

    def rpc(page, name, action):
        with page.expect_response(lambda r: r.request.method == "POST" and
                                  urlparse(r.url).path == "/rest/v1/rpc/" + name) as pending:
            action()
        response = pending.value
        if not response.ok:
            error = response.json()
            raise AssertionError(f"{name} returned HTTP {response.status}: {error.get('message', '')}")
        return response

    def claim(landlord, resident, lease_id):
        go(landlord, "/lease/" + lease_id)
        invitation = rpc(landlord, "create_tenant_invite", button(landlord, "Generate tenant invitation").click).json()
        code = (invitation[0] if isinstance(invitation, list) else invitation)["code"]
        hidden.append(code)
        go(resident, "/claim?code=" + quote(code))
        rpc(resident, "claim_tenant_invite", button(resident, "Join lease").click)
        resident.wait_for_url(lambda url: urlparse(url).path.startswith("/tenant"))

    def open_history(page, kind, row_id):
        go(page, "/" + kind + "/" + row_id)
        button(page, "Condition & repair history").click()
        expect(button(page, "Record entry")).to_be_visible()

    def record_history(page, kind, title, observed, *, phase=None, condition=None, finding=None):
        button(page, "Record entry").click()
        form = page.get_by_role("dialog")
        button(form, kind).click()
        field(form, "Title", title)
        field(form, "Observed on (YYYY-MM-DD)", observed)
        if phase:
            form.get_by_role("button", name=re.compile(r"^Resident Alpha ·")).click()
            button(form, phase).click()
            field(form, "Room or area", "Kitchen")
            button(form, condition).click()
            field(form, "Finding", finding)
        else:
            field(form, "Notes", "Service valve tested at the heater.")
        rpc(page, "record_property_history", button(form, "Save entry").click)
        expect(form).to_have_count(0)
        expect(page.get_by_text(title, exact=True)).to_be_visible()

    def history_csv(page, filename):
        with page.expect_download() as pending:
            button(page, "Export filtered history").click()
        destination = args.output / filename
        pending.value.save_as(destination)
        protect_file(destination)
        with destination.open(encoding="utf-8-sig", newline="") as stream:
            return list(csv.DictReader(stream))

    try:
        active = "create disposable actors and property fixtures"
        owner, manager, first_resident, next_resident = [principal(role) for role in ("owner", "manager", "first", "next")]
        token = owner["token"]
        prop = api.insert("properties", {"owner_id": owner["id"], "name": "Assigned records property", "currency": "USD"}, token)
        private = api.insert("properties", {"owner_id": owner["id"], "name": "Separate records property", "currency": "USD"}, token)
        unit = api.insert("units", {"owner_id": owner["id"], "property_id": prop["id"], "label": "Unit 4"}, token)
        asset = api.insert("assets", {"owner_id": owner["id"], "property_id": prop["id"], "unit_id": unit["id"],
                                     "name": "Unit 4 heater"}, token)
        today = date.today()
        original = api.insert("leases", {"owner_id": owner["id"], "unit_id": unit["id"], "tenant_name": "Resident Alpha",
            "tenant_email": first_resident["email"], "start_date": str(today - timedelta(days=60)),
            "status": "active", "rent_amount": 1000, "rent_currency": "USD"}, token)
        playwright = sync_playwright().start()
        browser = playwright.chromium.launch(headless=True, executable_path=args.browser,
                                             args=["--no-sandbox", "--disable-background-networking"])
        owner_page, manager_page, tenant_page = [sign_in(p) for p in (owner, manager, first_resident)]

        active = "invite and accept property manager through Properties"
        go(owner_page, "/property/" + prop["id"])
        field(owner_page, "Manager email", manager["email"])
        rpc(owner_page, "invite_property_manager", button(owner_page, "Create manager invitation").click)
        expect(owner_page.get_by_text("Invited · " + manager["email"], exact=True)).to_be_visible()
        go(manager_page, "/properties")
        rpc(manager_page, "accept_manager_invitation", button(manager_page, "Accept manager invitation").click)
        card = manager_page.get_by_role("button", name=re.compile(prop["name"]))
        expect(card).to_be_visible()
        expect(manager_page.get_by_text(private["name"], exact=True)).to_have_count(0)
        card.click()
        expect(manager_page.get_by_text(unit["label"], exact=True)).to_be_visible()
        go(manager_page, "/property/" + private["id"])
        expect(button(manager_page, "Back to properties")).to_be_visible()
        assert api.select("properties", manager["token"], id=private["id"]) == []
        checkpoint("Manager accepts a real invitation, opens the assigned property, and cannot open the second property")

        active = "record charge and partial receipt in owner and tenant portals"
        claim(owner_page, tenant_page, original["id"])
        go(owner_page, "/lease/" + original["id"])
        owner_page.get_by_text("Record", exact=True).click()
        form = owner_page.get_by_role("dialog")
        field(form, "Amount (USD)", "1000")
        field(form, "Due date", str(today - timedelta(days=7)))
        field(form, "Note", "Monthly lease charge")
        button(form, "Save").click()
        expect(form).to_have_count(0)
        button(owner_page, "Apply receipt").click()
        form = owner_page.get_by_role("dialog")
        field(form, "Amount to apply (USD)", "400")
        field(form, "Receipt note (optional)", "First instalment")
        rpc(owner_page, "apply_rent_receipt", button(form, "Apply receipt").click)
        expect(owner_page.get_by_text("$600.00 remaining", exact=True)).to_be_visible()
        go(tenant_page, "/tenant/rent")
        expect(tenant_page.get_by_text("$600.00 remaining", exact=True)).to_be_visible()
        expect(tenant_page.get_by_text("First instalment", exact=True)).to_be_visible()
        checkpoint("Both parties see $600 remaining after an owner records a $1,000 charge and a $400 receipt")

        active = "asset manual event and unit history"
        open_history(owner_page, "asset", asset["id"])
        record_history(owner_page, "Observation", "Heater shutoff tested", str(today - timedelta(days=3)))
        open_history(owner_page, "unit", unit["id"])
        expect(owner_page.get_by_text("Heater shutoff tested", exact=True)).to_be_visible()
        first_title, last_title = "Initial room inspection", "Final room inspection"
        first_day, last_day = str(today - timedelta(days=28)), str(today - timedelta(days=1))
        active = "move-in and move-out room inspection"
        record_history(owner_page, "Inspection", first_title, first_day, phase="Move In", condition="Good", finding="Finish intact")
        record_history(owner_page, "Inspection", last_title, last_day, phase="Move Out", condition="Worn", finding="Scuff by sink")
        button(owner_page, "Compare inspections").click()
        owner_page.get_by_role("button", name=re.compile(re.escape(first_day) + ".*" + first_title)).click()
        comparison = owner_page.get_by_text("Later inspection at this location", exact=True).locator("..")
        comparison.get_by_role("button", name=re.compile(last_title)).click()
        expect(owner_page.get_by_text("Good · Finish intact", exact=True)).to_have_count(2)
        expect(owner_page.get_by_text("Worn · Scuff by sink", exact=True)).to_have_count(2)
        button(owner_page, "Close comparison").click()
        field(owner_page, "Search history", "room inspection")
        records = history_csv(owner_page, "unit-inspections.csv")
        assert {row["Title"] for row in records} == {first_title,last_title}
        for row in records:
            expected = ("move_in", "good", "Finish intact") if row["Title"] == first_title else ("move_out", "worn", "Scuff by sink")
            assert row["Type"] == "inspection" and row["Inspection"] == expected[0]
            rooms = json.loads(row["Room observations and photo references"])
            assert [(r["room"], r["condition"], r["notes"]) for r in rooms] == [("Kitchen", *expected[1:])]
            assert "Unit 4" in row["Location"]
        checkpoint("Unit history includes its asset observation, compares the two room conditions, and exports the filtered inspection CSV", csv_rows=len(records))

        active = "archive first tenancy and retain owner history"
        go(owner_page, "/unit/" + unit["id"])
        owner_page.get_by_text("Resident Alpha", exact=True).click()
        rpc(owner_page, "revoke_lease_portal", button(owner_page.get_by_role("dialog"), "Archive lease").click)
        owner_page.get_by_text("Lease history", exact=True).click()
        expect(owner_page.get_by_text(re.compile("Archived tenancy"))).to_be_visible()
        expect(owner_page.get_by_text("$600.00 remaining", exact=True)).to_be_visible()
        go(tenant_page, "/tenant/rent")
        expect(tenant_page.get_by_text("Nothing recorded yet", exact=True)).to_be_visible()
        assert api.select("rent_record_balances", first_resident["token"], lease_id=original["id"]) == []

        active = "create successor lease via unit and verify tenancy isolation"
        go(owner_page, "/unit/" + unit["id"])
        owner_page.get_by_text("Lease & tenant", exact=True).locator("..").get_by_text("Add", exact=True).click()
        form = owner_page.get_by_role("dialog")
        field(form, "Tenant name", "Resident Beta")
        field(form, "Tenant email (optional)", next_resident["email"])
        field(form, "Rent (USD)", "1050")
        button(form, "Save").click()
        expect(form).to_have_count(0)
        expect(owner_page.get_by_text("Resident Beta", exact=True)).to_be_visible()
        successor = api.select("leases", token, unit_id=unit["id"], tenant_name="Resident Beta")
        assert len(successor) == 1 and successor[0]["id"] != original["id"]
        successor_page = sign_in(next_resident)
        claim(owner_page, successor_page, successor[0]["id"])
        go(successor_page, "/tenant/rent")
        expect(successor_page.get_by_text("Nothing recorded yet", exact=True)).to_be_visible()
        assert api.select("rent_record_balances", next_resident["token"], lease_id=original["id"]) == []
        open_history(owner_page, "unit", unit["id"])
        for title in ("Heater shutoff tested",first_title,last_title):
            expect(owner_page.get_by_text(title, exact=True)).to_be_visible()
        open_history(owner_page, "asset", asset["id"])
        after = history_csv(owner_page, "asset-history-after-turnover.csv")
        assert {row["Title"] for row in after} >= {"Heater shutoff tested"}
        assert {first_title,last_title}.isdisjoint(row["Title"] for row in after)
        checkpoint("Archived rent and unit/asset history survive turnover; neither the former nor the successor resident can read the previous ledger")
        assert not result["page_errors"] and not result["blocked_requests"], "Browser errors or external requests occurred"
        result["status"] = "passed"
    except Exception as failure:
        result["status"] = "failed"
        result["failure"] = {"step": active, "type": type(failure).__name__, "message": safe(failure)[:2200]}
        for i, context in enumerate(contexts):
            if context.pages:
                try:
                    path = args.output / f"failure-{i}.txt"
                    path.write_text(safe(context.pages[-1].locator("body").inner_text())[:14000])
                    protect_file(path)
                except Exception:
                    pass
    finally:
        for context in contexts:
            context.close()
        if browser:
            browser.close()
        if playwright:
            playwright.stop()
        cleanup = [api.cleanup_synthetic_user(uid) for uid in reversed(users)]
        result["cleanup"] = cleanup
        if any(item["status"] != "deleted" for item in cleanup):
            result["status"] = "failed"
        save()
    print(json.dumps({"status": result["status"], "checks": len(result["checks"]),
                      "report": str(report_file), "failure": result.get("failure")}), flush=True)
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
