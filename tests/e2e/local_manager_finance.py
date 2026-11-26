"""Verify delegated rent, downloaded statements, lost acknowledgements and ownership transfer in Chromium."""

import argparse
import csv
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
from urllib.parse import urlparse
from uuid import uuid4

from local_e2e import LOOPBACK, LocalAPI, local_url, private_credentials


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--credentials-file", type=Path, required=True)
    parser.add_argument("--allow-disposable-local", action="store_true", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--browser", default="/usr/bin/chromium")
    args = parser.parse_args()
    base = local_url(args.base_url, root=True)
    target = private_credentials(args.credentials_file)

    from playwright.sync_api import expect, sync_playwright

    os.umask(0o077)
    args.output.mkdir(parents=True, mode=0o700, exist_ok=False)
    private = [target["service"], target["anon"]]
    api = LocalAPI(target, private)
    report = {"status": "failed", "checks": [], "browser_errors": [], "external_hosts": []}
    actor_ids = []
    tag = uuid4().hex[:12]
    today = datetime.now(timezone.utc).date().isoformat()

    def actor(role):
        email = f"rentview-ledger-{tag}-{role}@example.test"
        password = secrets.token_urlsafe(32)
        private.append(password)
        uid = api.admin_user(email, password, f"Finance {role}")
        actor_ids.append(uid)
        verified, token = api.login(email, password)
        assert verified == uid
        return {"id": uid, "email": email, "password": password, "token": token}

    def button(page, name):
        return page.get_by_role("button", name=name, exact=True)

    def check(name):
        report["checks"].append(name)
        print(json.dumps({"passed": name}), flush=True)

    def property_lease(label):
        scope = {"owner_id": owner["id"]}
        prop = api.insert("properties", {**scope, "name": label, "currency": "USD"}, owner["token"])
        unit = api.insert("units", {**scope, "property_id": prop["id"], "label": "2B"}, owner["token"])
        lease = api.insert("leases", {**scope, "unit_id": unit["id"], "tenant_name": label + " resident",
                                      "status": "active", "rent_currency": "USD"}, owner["token"])
        return prop, lease

    def delegate(prop):
        api.rpc("invite_property_manager", {"p_property": prop["id"], "p_email": manager["email"]}, owner["token"])
        api.rpc("accept_manager_invitation", {"p_property": prop["id"]}, manager["token"])

    def restrict(route):
        destination = urlparse(route.request.url)
        if destination.scheme in ("blob", "data") or destination.hostname in LOOPBACK:
            route.continue_()
        else:
            report["external_hosts"].append(destination.hostname)
            route.abort("blockedbyclient")

    def restrict_socket(route):
        host = urlparse(route.url).hostname
        if host in LOOPBACK:
            route.connect_to_server()
        else:
            report["external_hosts"].append(host)
            route.close()

    def export(manager_page, filename):
        manager_page.goto("/export")
        expect(manager_page.get_by_text(assigned["name"], exact=True)).to_be_visible()
        with manager_page.expect_download() as download:
            button(manager_page, "Export rent and expenses CSV").click()
        destination = args.output / filename
        download.value.save_as(destination)
        with destination.open(encoding="utf-8-sig", newline="") as stream:
            rows = list(csv.DictReader(stream))
        receipts = [row for row in rows if row["Entry"] == "Rent received"]
        assert all(row["Property"] == assigned["name"] and row["Unit"] == "2B" and
                   row["Date"] == today and row["Currency"] == "USD" for row in receipts)
        return sorted(row["Amount"] for row in receipts), [row["Amount"] for row in rows if row["Entry"] == "Total rent received"]

    step = "fixture setup"
    try:
        owner, manager = actor("owner"), actor("manager")
        assigned, lease = property_lease("Assigned ledger")
        other, private_lease = property_lease("Unassigned ledger")
        charge = api.insert("rent_payments", {"owner_id": owner["id"], "lease_id": lease["id"],
                            "amount": 1000, "currency": "USD", "due_date": today, "method": None}, owner["token"])
        api.insert("rent_payments", {"owner_id": owner["id"], "lease_id": private_lease["id"],
                   "amount": 87, "currency": "USD", "paid_on": today}, owner["token"])
        delegate(assigned)
        lease_path = "/lease/" + lease["id"]
        endpoint = target["url"] + "/rest/v1/rpc/apply_rent_receipt"

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.browser, headless=True,
                                                  args=["--no-sandbox", "--disable-background-networking"])
            context = browser.new_context(base_url=base, timezone_id="UTC", locale="en-US",
                                          service_workers="block", accept_downloads=True)
            context.route("**/*", restrict)
            context.route_web_socket("**/*", restrict_socket)
            page = context.new_page()
            page.set_default_timeout(18_000)
            page.on("pageerror", lambda error: report["browser_errors"].append(str(error)))
            page.on("dialog", lambda dialog: dialog.accept())
            step = "delegated manager sign-in and partial allocation"
            page.goto("/login")
            page.get_by_label("Email", exact=True).fill(manager["email"])
            page.get_by_label("Password", exact=True).fill(manager["password"])
            button(page, "Sign in").click()
            page.wait_for_url(lambda url: urlparse(url).path.rstrip("/") != "/login")
            page.goto(lease_path)
            button(page, "Apply receipt").click()
            form = page.get_by_role("dialog")
            form.get_by_label("Amount to apply (USD)", exact=True).fill("400")
            form.get_by_label("Receipt note (optional)", exact=True).fill("Manager instalment")
            button(form, "Apply receipt").click()
            expect(form).to_have_count(0)
            expect(page.get_by_text("$600.00 remaining", exact=True)).to_be_visible()
            check("Delegated manager applies $400 to a $1,000 charge and sees $600 remaining")

            step = "scoped manager operating statement"
            assert export(page, "partial-statement.csv") == (["400.00"], ["400.00"])
            check("Manager statement includes the $400 receipt and excludes the unassigned property's $87")

            step = "commit mark paid, drop its response, retry the same operation"
            page.goto(lease_path)
            commands = []
            committed = []

            def drop_first_ack(route):
                if route.request.method != "POST":
                    return route.continue_()
                commands.append(route.request.post_data_json)
                if len(commands) == 1:
                    # PostgREST receives the real authenticated request and commits.
                    # Only the response to the initiating browser is discarded.
                    response = route.fetch(max_redirects=0)
                    committed.append((response.status, response.json()))
                    response.dispose()
                    route.abort("connectionreset")
                else:
                    route.continue_()

            page.route(endpoint, drop_first_ack)
            mark_paid = button(page, "Mark paid today")
            with page.expect_event("dialog", predicate=lambda dialog: "Could not mark payment paid" in dialog.message):
                mark_paid.click()
            assert len(commands) == 1 and committed[0][0] == 200
            assert committed[0][1] == commands[0]["p_operation_id"]
            assert len(api.select("rent_allocations", manager["token"], charge_id=charge["id"])) == 2
            expect(page.get_by_text("$600.00 remaining", exact=True)).to_be_visible()
            mark_paid.click()
            expect(page.get_by_text("Paid in full", exact=True)).to_be_visible()
            assert len(commands) == 2 and commands[0] == commands[1]
            assert commands[0]["p_method"] is None and commands[0]["p_amount"] == 600
            page.unroute(endpoint, drop_first_ack)
            records = api.select("rent_payments", owner["token"], lease_id=lease["id"])
            receipts = [row for row in records if row["paid_on"]]
            assert sorted(row["amount"] for row in receipts) == [400, 600]
            assert next(row for row in receipts if row["amount"] == 600)["method"] is None
            assert export(page, "settled-statement.csv") == (["400.00", "600.00"], ["1000.00"])
            check("Lost acknowledgement and a second click produce one $600 receipt with a blank method and $1,000 total")

            step = "accept transfer and reload the reconciled ledger"
            delegate(other)
            api.rpc("offer_portfolio_transfer", {"p_successor": manager["id"]}, owner["token"])
            page.goto("/properties")
            with page.expect_response(lambda response: urlparse(response.url).path == "/rest/v1/rpc/accept_portfolio_transfer"
                                      and response.request.method == "POST") as pending:
                button(page, "Accept portfolio ownership").click()
            assert pending.value.ok
            page.goto(lease_path)
            expect(page.get_by_text("Paid in full", exact=True)).to_be_visible()
            inherited = api.select("rent_payments", manager["token"], lease_id=lease["id"])
            assert len(inherited) == 3 and all(row["owner_id"] == manager["id"] for row in inherited)
            assert len(api.select("rent_allocations", manager["token"], charge_id=charge["id"])) == 2
            assert api.select("rent_payments", owner["token"], lease_id=lease["id"]) == []
            check("Successor opens the settled ledger after transfer and retains both allocations")
            browser.close()
        assert not report["browser_errors"] and not report["external_hosts"]
        report["status"] = "passed"
    except Exception as error:
        report["failure"] = {"step": step, "message": str(error)[:1600]}
    finally:
        report["cleanup"] = [api.cleanup_synthetic_user(uid) for uid in reversed(actor_ids)]
        if any(entry["status"] != "deleted" for entry in report["cleanup"]):
            report["status"] = "failed"
        encoded = json.dumps(report, indent=2)
        for value in sorted(private, key=len, reverse=True):
            encoded = encoded.replace(value, "[private]")
        (args.output / "results.json").write_text(re.sub(r"eyJ[A-Za-z0-9_.-]{30,}", "[token]", encoded) + "\n")
    print(json.dumps({"status": report["status"], "report": str(args.output / "results.json")}), flush=True)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
