"""Exercise owner portfolio screens in Chromium against a disposable, loopback Supabase.

The API creates one synthetic owner and property and independently verifies persisted
records. All vendor, inventory, asset, schedule and announcement changes use the UI.
"""
import argparse
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

from local_e2e import LOOPBACK, LocalAPI, local_url, private_credentials


def vendors(page, api, token, tag):
    name = f"Boiler services {tag}"
    page.get_by_text("Add", exact=True).click()
    page.get_by_label("Name", exact=True).fill(name)
    page.get_by_label("Trade", exact=True).fill("Heating")
    page.get_by_label("Company", exact=True).fill("Maintenance contractors")
    page.get_by_role("dialog").get_by_role("button", name="Save", exact=True).click()
    page.get_by_label("Search vendors").fill("Heating")
    page.get_by_text(name, exact=True).click()
    page.get_by_label("Notes", exact=True).fill("Call the duty supervisor")
    page.get_by_role("dialog").get_by_role("button", name="Save", exact=True).click()
    expect(page.get_by_role("dialog")).to_have_count(0)
    [vendor] = api.select("vendors", token, name=name)
    assert vendor["trade"] == "Heating" and vendor["notes"] == "Call the duty supervisor"
    page.reload()
    page.get_by_text(name, exact=True).click()
    page.get_by_role("button", name="Delete vendor", exact=True).click()
    expect(page.get_by_text("No vendors", exact=True)).to_be_visible()
    assert api.select("vendors", token, id=vendor["id"]) == []


def inventory(page, api, token, tag):
    name = f"Pumps {tag}"
    page.get_by_text("Add", exact=True).click()
    page.get_by_label("Name", exact=True).fill(name)
    page.get_by_label("Quantity on hand").fill("2")
    page.get_by_label("Low-stock alert at (optional)", exact=True).fill("3")
    page.get_by_label("Unit cost (optional)", exact=True).fill("14.25")
    page.get_by_label("Currency", exact=True).fill("EUR")
    page.get_by_label("Storage location (optional)", exact=True).fill("Workshop")
    page.get_by_role("dialog").get_by_role("button", name="Save", exact=True).click()
    expect(page.get_by_text("1 item at or below low-stock level.")).to_be_visible()
    page.get_by_label("Search inventory").fill("Workshop")
    page.get_by_text(name, exact=True).click()
    page.get_by_label("Quantity on hand").fill("5")
    page.get_by_role("dialog").get_by_role("button", name="Save", exact=True).click()
    expect(page.get_by_role("dialog")).to_have_count(0)
    expect(page.get_by_text("1 item at or below low-stock level.")).to_have_count(0)
    [item] = api.select("inventory_items", token, name=name)
    assert (item["quantity"], item["unit_cost"], item["cost_currency"]) == (5, 14.25, "EUR")
    page.reload()
    page.get_by_text(name, exact=True).click()
    page.get_by_role("button", name="Delete item", exact=True).click()
    expect(page.get_by_text("No supplies tracked", exact=True)).to_be_visible()
    assert api.select("inventory_items", token, id=item["id"]) == []


def asset_and_maintenance(page, api, token, tag, prop):
    name, title = f"Plant pump {tag}", f"Inspect pump {tag}"
    page.get_by_text("Add", exact=True).click()
    page.get_by_label("Name", exact=True).fill(name)
    page.get_by_role("dialog").get_by_text(prop["name"], exact=True).click()
    page.get_by_role("dialog").get_by_role("button", name="Save", exact=True).click()
    page.get_by_text(name, exact=True).click()
    page.get_by_role("button", name="Edit details").click()
    serial = page.get_by_role("dialog").get_by_label("Serial number", exact=True)
    serial.press_sequentially(tag)
    serial.press("Tab")
    expect(serial).to_have_value(tag)
    with page.expect_response(lambda response: response.request.method == "PATCH" and urlparse(response.url).path == "/rest/v1/assets") as update:
        page.get_by_role("dialog").get_by_role("button", name="Save", exact=True).click()
    assert update.value.ok, f"Asset edit returned {update.value.status}"
    [asset] = api.select("assets", token, name=name)
    assert asset["property_id"] == prop["id"] and asset["serial_number"] == tag, "Asset edit did not persist the serial number"
    expect(page.get_by_text(tag, exact=True)).to_be_visible()

    page.get_by_role("button", name="Schedule service").click()
    page.get_by_label("Title", exact=True).fill(title)
    page.get_by_role("button", name="Weekly", exact=True).click()
    completed = datetime.now(timezone.utc).date()
    page.get_by_label("Next due date (YYYY-MM-DD)", exact=True).fill(completed.isoformat())
    page.get_by_role("dialog").get_by_role("button", name="Save", exact=True).click()
    page.get_by_role("button", name="Mark done").click()
    page.get_by_label("Completed on (YYYY-MM-DD)", exact=True).fill(completed.isoformat())
    findings = page.get_by_role("dialog").get_by_label("Work done / findings (optional)", exact=True)
    findings.press_sequentially("Seal and pressure checked")
    findings.press("Tab")
    expect(findings).to_have_value("Seal and pressure checked")
    with page.expect_response(lambda response: urlparse(response.url).path == "/rest/v1/rpc/complete_maintenance_schedule") as completion:
        page.get_by_role("dialog").get_by_role("button", name="Record completion", exact=True).click()
    assert completion.value.ok and completion.value.request.post_data_json["p_notes"] == "Seal and pressure checked"
    expect(page.get_by_role("dialog")).to_have_count(0)
    page.get_by_role("button", name="History", exact=True).click()
    expect(page.get_by_text("Seal and pressure checked", exact=True)).to_be_visible()
    page.get_by_role("button", name="Close history").click()
    page.get_by_role("button", name="Pause", exact=True).click()
    expect(page.get_by_text("No schedules match", exact=True)).to_be_visible()
    page.get_by_role("button", name="Include paused", exact=True).click()
    page.get_by_role("button", name="Resume", exact=True).click()
    expect(page.get_by_role("button", name="Pause", exact=True)).to_be_visible()
    [schedule] = api.select("maintenance_schedules", token, title=title)
    assert schedule["asset_id"] == asset["id"] and schedule["is_active"] is True
    assert schedule["next_due"] == (completed + timedelta(days=7)).isoformat()
    [history] = api.select("maintenance_completions", token, schedule_id=schedule["id"])
    assert history["completed_on"] == completed.isoformat() and history["notes"] == "Seal and pressure checked"
    page.goto(f"/asset/{asset['id']}")
    page.get_by_label("Retire asset and preserve history", exact=True).click()
    expect(page.get_by_text("out of service", exact=True)).to_be_visible()
    [retired] = api.select("assets", token, id=asset["id"])
    assert retired["status"] == "out_of_service"
    assert len(api.select("maintenance_completions", token, schedule_id=schedule["id"])) == 1


def announcement(page, api, token, tag, prop):
    title = f"Boiler inspection {tag}"
    page.get_by_text("Post", exact=True).click()
    page.get_by_label("Title", exact=True).fill(title)
    page.get_by_label("Details", exact=True).fill("Service is scheduled from 10 to 11.")
    page.get_by_role("dialog").get_by_text(prop["name"], exact=True).click()
    page.get_by_role("dialog").get_by_role("button", name="Post", exact=True).click()
    expect(page.get_by_text(title, exact=True)).to_be_visible()
    page.reload()
    expect(page.get_by_text("Service is scheduled from 10 to 11.", exact=True)).to_be_visible()
    [notice] = api.select("announcements", token, title=title)
    assert notice["property_id"] == prop["id"] and notice["body"] == "Service is scheduled from 10 to 11."


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
    os.umask(0o077)
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    tag = uuid4().hex[:12]
    email = f"rentview-portfolio-{tag}@example.test"
    password = secrets.token_urlsafe(32)
    secret_values = [password, target["anon"], target["service"]]
    api = LocalAPI(target, secret_values)
    report = {"status": "failed", "checks": [], "browser_errors": [], "external_requests": [], "cleanup": []}
    step = "fixture setup"
    uid = None

    def guard(route):
        parsed = urlparse(route.request.url)
        if parsed.scheme in ("data", "blob") or parsed.hostname in LOOPBACK:
            route.continue_()
        else:
            report["external_requests"].append(parsed.hostname)
            route.abort("blockedbyclient")

    def guard_ws(route):
        host = urlparse(route.url).hostname
        if host in LOOPBACK:
            route.connect_to_server()
        else:
            report["external_requests"].append(host)
            route.close()

    try:
        uid = api.admin_user(email, password, "Fixture portfolio operations")
        _, token = api.login(email, password)
        prop = api.insert("properties", {"owner_id": uid, "name": f"Boiler House {tag}"}, token)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=args.browser, args=["--no-sandbox", "--disable-background-networking"])
            context = browser.new_context(base_url=base, timezone_id="UTC", service_workers="block")
            context.route("**/*", guard)
            context.route_web_socket("**/*", guard_ws)
            page = context.new_page()
            page.set_default_timeout(12000)
            page.on("pageerror", lambda error: report["browser_errors"].append(str(error)))
            page.on("dialog", lambda dialog: dialog.accept())
            step = "owner sign-in"
            page.goto("/login")
            page.get_by_label("Email", exact=True).fill(email)
            page.get_by_label("Password", exact=True).fill(password)
            page.get_by_role("button", name="Sign in", exact=True).click()
            expect(page.get_by_role("button", name="Open Work", exact=True)).to_be_visible(timeout=30000)
            for step, link, work, extra in [
                ("Vendor creation, search, edit and deletion", "Vendors", vendors, ()),
                ("Stock creation, threshold, restocking and deletion", "Inventory & parts", inventory, ()),
                ("Asset registration, maintenance history, pause, resume and retirement", "Assets", asset_and_maintenance, (prop,)),
                ("Property announcement publication and reload", "Announcements", announcement, (prop,)),
            ]:
                page.goto("/more")
                page.get_by_text(link, exact=True).click()
                try:
                    work(page, api, token, tag, *extra)
                except Exception:
                    report["visible_screen"] = page.locator("body").inner_text()[:4000]
                    raise
                report["checks"].append(step)
            browser.close()
        step = "browser errors and external requests"
        assert not report["browser_errors"] and not report["external_requests"]
        report["status"] = "passed"
    except Exception as error:
        report["failed_step"] = step
        report["error"] = str(error)
    finally:
        if uid:
            cleanup = api.cleanup_synthetic_user(uid)
            report["cleanup"].append(cleanup)
            if cleanup["status"] != "deleted":
                report["status"] = "failed"
        encoded = json.dumps(report, indent=2)
        for secret in sorted(secret_values, key=len, reverse=True):
            encoded = encoded.replace(secret, "[redacted]")
        (args.output / "results.json").write_text(encoded + "\n")
        print(f"{report['status']}: {len(report['checks'])} portfolio workflows. Report: {args.output / 'results.json'}")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
