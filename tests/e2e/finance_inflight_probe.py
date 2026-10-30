"""Hold an actual committed expense response and test interrupted form navigation.

Only synthetic local identities and loopback routes are allowed. The server's
successful response is retained while the user attempts Cancel and another form;
it is then released unchanged, so stale completion effects can be observed.
"""
import argparse
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
    result = {"status": "running", "scope": "synthetic local browser/Auth/Data API; actual committed response held", "page_errors": [], "blocked_requests": []}
    uid = None
    held = []
    try:
        from playwright.sync_api import expect, sync_playwright
        email = f"rentview-inflight-{uuid4().hex[:12]}@example.test"
        password = "Rv!" + secrets.token_urlsafe(24)
        uid = api.admin_user(email, password, "Fixture in-flight finance")
        _, token = api.login(email, password)
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
            page.on("dialog", lambda dialog: dialog.accept())
            page.goto(base + "/login", wait_until="domcontentloaded")
            page.get_by_label("Email", exact=True).fill(email)
            page.get_by_label("Password", exact=True).fill(password)
            page.get_by_role("button", name="Sign in", exact=True).click()
            expect(page.get_by_role("button", name="Open Work", exact=True)).to_be_visible(timeout=30_000)
            def hold_response(route):
                parsed = urlparse(route.request.url)
                assert parsed.hostname in LOOPBACK
                if route.request.method != "POST":
                    route.continue_()
                    return
                response = route.fetch(max_redirects=0, timeout=12_000)
                assert response.status == 201, "In-flight probe did not commit a real expense"
                held.append((route, response))
            page.route("**/rest/v1/expenses*", hold_response)
            page.goto(base + "/expenses?new=1", wait_until="domcontentloaded")
            page.get_by_label("Amount", exact=True).fill("31.45")
            page.get_by_label("Description (optional)", exact=True).fill("Finance held original expense")
            page.get_by_role("button", name="Save", exact=True).click()
            expect(page.get_by_role("button", name="Save", exact=True)).to_be_disabled()
            # Pump browser events until the route has actually committed, without
            # treating a UI spinner as evidence that the backend write occurred.
            deadline = __import__("time").monotonic() + 15
            while not held:
                assert __import__("time").monotonic() < deadline, "Real expense response was not captured"
                page.wait_for_timeout(50)
            assert len(api.select("expenses", token, description="Finance held original expense")) == 1
            cancel = page.get_by_role("button", name="Cancel", exact=True)
            result["cancel_enabled_during_save"] = cancel.is_enabled()
            result["description_editable_during_save"] = page.get_by_label("Description (optional)", exact=True).is_editable()
            assert not result["description_editable_during_save"], "Typing could change a submitted draft while its save is in flight"
            if cancel.is_enabled():
                cancel.click()
                expect(page.get_by_role("dialog")).to_have_count(0)
                page.get_by_text("Add", exact=True).click()
                page.get_by_label("Amount", exact=True).fill("72.80")
                page.get_by_label("Description (optional)", exact=True).fill("Finance second unsaved draft")
                result["second_draft_opened_before_original_completion"] = True
            else:
                result["second_draft_opened_before_original_completion"] = False
                page.keyboard.press("Escape")
                expect(page.get_by_role("dialog")).to_have_count(1)
                expect(page.get_by_role("button", name="Save", exact=True)).to_be_disabled()
                result["escape_preserves_inflight_form"] = True
            route, response = held.pop()
            route.fulfill(response=response)
            if result["cancel_enabled_during_save"]:
                # The newer form still shares the original saving state. Wait
                # until that state settles or the form is removed before
                # inspecting it; no fixed delay stands in for completion.
                page.wait_for_function("() => { const save=document.querySelector('[role=button][aria-label=Save]'); return !save || save.getAttribute('aria-disabled') !== 'true'; }")
                field = page.get_by_label("Description (optional)", exact=True)
                result["second_draft_survived_original_completion"] = field.count() == 1 and field.is_visible() and field.input_value() == "Finance second unsaved draft"
                assert result["second_draft_survived_original_completion"], "A stale successful save closed or reset the newer expense draft"
            else:
                expect(page.get_by_role("dialog")).to_have_count(0)
                page.get_by_text("Add", exact=True).click()
                page.get_by_label("Amount", exact=True).fill("72.80")
                page.get_by_label("Description (optional)", exact=True).fill("Finance second unsaved draft")
                expect(page.get_by_label("Description (optional)", exact=True)).to_have_value("Finance second unsaved draft")
                result["second_draft_after_original_completion"] = "preserved"
            assert len(api.select("expenses", token, description="Finance held original expense")) == 1
            assert api.select("expenses", token, description="Finance second unsaved draft") == []
            assert not result["page_errors"] and not result["blocked_requests"]
            context.close()
            browser.close()
        result["status"] = "passed"
    except Exception as failure:
        result["status"] = "failed"
        result["failure"] = {"type": type(failure).__name__, "message": "In-flight navigation check failed; see bounded observations"}
    finally:
        for route, _ in held:
            try:
                route.abort()
            except Exception:
                pass
        cleanup = api.cleanup_synthetic_user(uid) if uid else None
        errors = int(cleanup is not None and cleanup["status"] != "deleted")
        result["cleanup"] = cleanup
        result["cleanup_errors"] = errors
        if errors:
            result["status"] = "failed"
        with os.fdopen(descriptor, "w") as stream:
            json.dump(result, stream, indent=2)
            stream.write("\n")
        print(json.dumps(result))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
    signal.alarm(120)
    raise SystemExit(main())
