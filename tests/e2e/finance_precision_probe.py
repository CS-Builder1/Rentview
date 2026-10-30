"""Reproduce visible cent drift using valid numeric(12,2) expenses locally."""
import argparse
from decimal import Decimal
import datetime as dt
import json
import os
from pathlib import Path
import secrets
import signal
from urllib.parse import urlparse
from uuid import uuid4

from local_e2e import LOOPBACK, LocalAPI, local_url, private_credentials


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--credentials-file", required=True, type=Path)
    parser.add_argument("--allow-disposable-local", action="store_true")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not args.allow_disposable_local:
        parser.error("Explicit disposable-local opt-in required")
    base = local_url(args.base_url, root=True)
    target = private_credentials(args.credentials_file)
    os.umask(0o077)
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    api = LocalAPI(target, [target["anon"], target["service"]])
    result = {"status": "running", "scope": "synthetic local browser/Data API only", "page_errors": [], "blocked_requests": []}
    uid = None
    try:
        from playwright.sync_api import expect, sync_playwright
        email = f"rentview-precision-{uuid4().hex[:12]}@example.test"
        password = "Rv!" + secrets.token_urlsafe(24)
        uid = api.admin_user(email, password, "Fixture cent precision")
        _, token = api.login(email, password)
        amount, count = "9999999999.99", 249
        expected = Decimal(amount) * count
        rows = [{"owner_id": uid, "amount": amount, "currency": "GBP", "category": "repair", "incurred_on": dt.datetime.now(dt.timezone.utc).strftime("%Y-01-31"), "description": f"Precision receipt {i:03d}"} for i in range(count)]
        status, _ = api.request("POST", "/rest/v1/expenses", token=token, body=rows, headers={"Prefer": "return=minimal"})
        assert status == 201
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox", "--disable-background-networking"])
            context = browser.new_context(locale="en-US", service_workers="block")
            def guard(route):
                parsed = urlparse(route.request.url)
                if parsed.hostname in LOOPBACK or parsed.scheme in {"data", "blob"}:
                    route.continue_()
                else:
                    result["blocked_requests"].append({"host": parsed.hostname, "path": parsed.path})
                    route.abort("blockedbyclient")
            context.route("**/*", guard)
            def guard_ws(route):
                parsed = urlparse(route.url)
                if parsed.hostname in LOOPBACK:
                    route.connect_to_server()
                else:
                    result["blocked_requests"].append({"host": parsed.hostname, "kind": "websocket"})
                    route.close()
            context.route_web_socket("**/*", guard_ws)
            page = context.new_page()
            page.on("pageerror", lambda error: result["page_errors"].append(type(error).__name__))
            page.goto(base + "/login", wait_until="domcontentloaded")
            page.get_by_label("Email", exact=True).fill(email)
            page.get_by_label("Password", exact=True).fill(password)
            page.get_by_role("button", name="Sign in", exact=True).click()
            expect(page.get_by_role("button", name="Open Work", exact=True)).to_be_visible(timeout=30_000)
            page.goto(base + "/expenses", wait_until="domcontentloaded")
            expect(page.get_by_text("Spend this year", exact=True)).to_be_visible(timeout=30_000)
            displayed = page.get_by_text("Spend this year", exact=True).locator("xpath=following-sibling::*[1]").inner_text()
            formatted = "£" + format(expected, ",.2f")
            result.update({"valid_expense_count": count, "valid_individual_amount": amount, "expected_exact_total": str(expected), "expected_display": formatted, "observed_summary": displayed})
            assert formatted in displayed, "Visible financial summary differs from exact valid expense sum"
            assert not result["page_errors"] and not result["blocked_requests"]
            context.close()
            browser.close()
        result["status"] = "passed"
    except Exception as failure:
        result["status"] = "failed"
        result["failure"] = {"type": type(failure).__name__, "message": "Precision browser check failed; see bounded numeric observations"}
    finally:
        cleanup = api.cleanup_synthetic_user(uid) if uid else None
        cleanup_errors = int(cleanup is not None and cleanup["status"] != "deleted")
        result["cleanup"] = cleanup
        result["cleanup_errors"] = cleanup_errors
        if cleanup_errors:
            result["status"] = "failed"
        with os.fdopen(descriptor, "w") as out:
            json.dump(result, out, indent=2)
            out.write("\n")
        print(json.dumps(result))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
    signal.alarm(90)
    raise SystemExit(main())
