"""Exercise clipboard invitation links and signed-out return through real local Auth."""
import argparse
import json
import os
import re
import secrets
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright
from local_e2e import LOOPBACK, LocalAPI, local_url, private_credentials, protect_file


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--credentials-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--allow-disposable-local", action="store_true", required=True)
    parser.add_argument("--browser", default="/usr/bin/chromium")
    args = parser.parse_args()
    base = local_url(args.base_url, root=True)
    target = private_credentials(args.credentials_file)
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    hidden = [target["anon"], target["service"]]
    api = LocalAPI(target, hidden)
    run = uuid4().hex[:10]
    report = {"status": "running", "checks": [], "blocked_hosts": [], "browser_errors": []}
    stage = "fixtures"
    contexts = []
    playwright = browser = None

    def scrub(value):
        text = str(value)
        for secret in sorted(hidden, key=len, reverse=True):
            text = text.replace(secret, "[fixture-secret]")
        text = re.sub(r"\b[A-Fa-f0-9]{32}\b|eyJ[A-Za-z0-9_.-]{30,}", "[token]", text)
        return text[:2000]

    def fixture(role):
        email = f"rentview-invites-{run}-{role}@example.test"
        password = "Rv!" + secrets.token_urlsafe(24)
        hidden.append(password)
        uid = api.admin_user(email, password, "Invitation " + role)
        return {"id": uid, "email": email, "password": password}

    def checked(check):
        report["checks"].append(check)
        print(json.dumps({"passed": check}), flush=True)

    def page_for_recipient(clipboard=False):
        context = browser.new_context(viewport={"width": 1100 if clipboard else 412,"height": 920},
                                      service_workers="block")
        contexts.append(context)
        if clipboard:
            context.grant_permissions(["clipboard-read", "clipboard-write"], origin=base)

        def network(route):
            parsed = urlparse(route.request.url)
            if parsed.hostname in LOOPBACK or parsed.scheme in {"data", "blob"}:
                route.continue_()
            else:
                report["blocked_hosts"].append(parsed.hostname)
                route.abort("blockedbyclient")

        def socket(route):
            host = urlparse(route.url).hostname
            if host in LOOPBACK: route.connect_to_server()
            else:
                report["blocked_hosts"].append(host)
                route.close()

        context.route("**/*", network)
        context.route_web_socket("**/*", socket)
        page = context.new_page()
        page.set_default_timeout(20000)
        page.on("pageerror", lambda error: report["browser_errors"].append(scrub(error)))
        page.on("dialog", lambda dialog: dialog.accept())
        return page

    def click(page, label):
        page.get_by_role("button", name=label, exact=True).click()

    def sign_in(page, actor):
        page.get_by_label("Email", exact=True).fill(actor["email"])
        page.get_by_label("Password", exact=True).fill(actor["password"])
        click(page, "Sign in")

    def copied(page, label, path):
        # Test the actual browser Clipboard API; neither generate nor reconstruct the link.
        page.bring_to_front()
        click(page, label)
        text = page.evaluate("navigator.clipboard.readText()")
        matches = re.findall(r"https?://[^\s]+", text)
        assert len(matches) == 1
        link = local_url(matches[0])
        parsed = urlparse(link)
        assert parsed.netloc == urlparse(base).netloc and parsed.path == path
        code = parse_qs(parsed.query)["code"][0]
        hidden.extend([code, code.lower(), link])
        return link, code

    def join(actor, link, code, field, acceptance, landing, heading):
        page = page_for_recipient()
        page.goto(link, wait_until="domcontentloaded")
        expect(page.get_by_label(field, exact=True)).to_have_value(code)
        click(page, "Continue to sign in or create account")
        expect(page.get_by_label("Email", exact=True)).to_be_visible()
        # Returning to plain /login also exercises the saved destination without
        # relying on preserved query parameters or a continuation injected by this test.
        page.goto(base + "/login", wait_until="domcontentloaded")
        sign_in(page, actor)
        expect(page.get_by_label(field, exact=True)).to_have_value(code, timeout=20000)
        click(page, acceptance)
        page.wait_for_url(lambda url:urlparse(url).path.rstrip("/") == landing)
        expect(page.get_by_text(heading, exact=True).filter(visible=True)).to_be_visible()
        # A fresh load should still have role/lease access after the invitation is consumed.
        page.reload(wait_until="domcontentloaded")
        expect(page.get_by_text(heading, exact=True).filter(visible=True)).to_be_visible()
        return page

    try:
        owner, manager, contractor, renter = [fixture(role) for role in ("owner", "manager", "contractor", "renter")]
        _, token = api.login(owner["email"], owner["password"])
        _, manager_token = api.login(manager["email"], manager["password"])
        prop = api.insert("properties", {"name": "Invitation Court " + run, "owner_id": owner["id"]}, token)
        unit = api.insert("units", {"property_id": prop["id"], "owner_id": owner["id"], "label": "West Flat"}, token)
        lease = api.insert("leases", {"owner_id": owner["id"], "unit_id": unit["id"], "status": "active",
                                     "tenant_name": "Invited Resident", "tenant_email": renter["email"]}, token)
        vendor = api.insert("vendors", {"property_id":prop["id"],"owner_id":owner["id"],
                                        "name":"Invited Plumbing "+run,"email":contractor["email"]}, token)
        api.rpc("invite_property_manager", {"p_property": prop["id"], "p_email": manager["email"]}, token)
        api.rpc("accept_manager_invitation", {"p_property": prop["id"]}, manager_token)
        playwright = sync_playwright().start()
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True,
                                              args=["--no-sandbox","--disable-background-networking"])
        staff = page_for_recipient(clipboard=True)
        staff.goto(base + "/login",wait_until="domcontentloaded")
        sign_in(staff,manager)
        expect(staff.get_by_role("button",name="Open Work",exact=True)).to_be_visible(timeout=20000)

        stage = "contractor invitation creation through Vendors"
        staff.get_by_role("tab",name=re.compile("More")).click()
        staff.get_by_text("Vendors",exact=True).filter(visible=True).click()
        staff.get_by_text(vendor["name"],exact=True).filter(visible=True).click()
        click(staff,"Create contractor invitation")
        expect(staff.get_by_role("button",name="Copy contractor invitation",exact=True)).to_be_visible()
        contractor_link, contractor_code = copied(staff,"Copy contractor invitation","/contractor-invite")
        checked("Delegated manager creates a contractor invitation through More, Vendors and the vendor record; copying yields an app-origin claim link")
        stage = "signed-out contractor authentication and claim"
        join(contractor,contractor_link,contractor_code,"Contractor invitation code","Accept invitation","/contractor","Assigned jobs")
        accounts = api.ok("GET",f"/rest/v1/contractor_accounts?vendor_id=eq.{vendor['id']}&select=user_id",admin=True)
        assert accounts == [{"user_id": contractor["id"]}]
        contractor_pending = api.ok("GET",f"/rest/v1/contractor_invites?vendor_id=eq.{vendor['id']}&select=vendor_id",admin=True)
        assert contractor_pending == []
        checked("Signed-out contractor follows the copied link, resumes it from bare sign-in, accepts, and retains the assigned-jobs portal after reload")

        stage = "manager sees contractor claim status"
        staff.bring_to_front()
        staff.reload(wait_until="domcontentloaded")
        staff.get_by_text(vendor["name"],exact=True).filter(visible=True).click()
        expect(staff.get_by_text("Edit vendor", exact=True).filter(visible=True)).to_be_visible()
        create_again = staff.get_by_role("button", name="Create contractor invitation", exact=True)
        report["manager_vendor_after_accept"] = {"shows_create_invitation": create_again.is_visible()}
        if create_again.is_visible():
            create_again.click()
            expect(staff.get_by_text("Contractor already connected",exact=True).filter(visible=True)).to_be_visible()
            report["manager_vendor_after_accept"]["response"] = "Contractor already connected"
        stage = "resident invitation creation through property and lease"
        staff.bring_to_front()
        staff.goto(base + "/",wait_until="domcontentloaded")
        staff.get_by_role("tab",name=re.compile("Properties")).click()
        staff.get_by_text(prop["name"],exact=True).filter(visible=True).click()
        staff.get_by_text(unit["label"],exact=True).filter(visible=True).click()
        staff.get_by_text("Invite to portal",exact=True).filter(visible=True).click()
        click(staff, "Generate tenant invitation")
        expect(staff.get_by_role("button",name="Copy invitation link",exact=True)).to_be_visible()
        renter_link, renter_code = copied(staff,"Copy invitation link","/claim")
        checked("Delegated manager generates and copies a resident invitation from Properties, unit and lease")
        stage = "signed-out resident authentication and claim"
        tenant_page = join(renter,renter_link,renter_code,"Invite code","Join lease","/tenant","My leases")
        expect(tenant_page.get_by_text(re.compile(re.escape(prop["name"]))).filter(visible=True).first).to_be_visible()
        saved = api.select("leases",token,id=lease["id"])[0]
        assert saved["tenant_user_id"] == renter["id"]
        recorded = api.select("tenant_invites",token,lease_id=lease["id"])
        assert len(recorded) == 1 and recorded[0]["claimed_by"] == renter["id"] and recorded[0]["claimed_at"]
        checked("Signed-out resident returns through authentication, claims the original lease and sees its property after reload")
        assert not report["blocked_hosts"] and not report["browser_errors"]
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["failure"] = {"step": stage, "error": scrub(error)}
        report["screens"] = []
        for context in contexts:
            for page in context.pages:
                try: report["screens"].append({"route":urlparse(page.url).path,"text":scrub(page.locator("body").inner_text(timeout=1500))})
                except Exception: pass
    finally:
        for context in contexts:
            try: context.close()
            except Exception: pass
        if browser: browser.close()
        if playwright: playwright.stop()
        results = [api.cleanup_synthetic_user(uid) for uid in reversed(list(api.synthetic_users))]
        report["cleanup"] = {"created":len(results), "deleted":sum(r["status"]=="deleted" for r in results),
                             "errors":[r for r in results if r["status"]!="deleted"]}
        if report["cleanup"]["errors"]: report["status"]="failed"
        output = args.output / f"invites-{run}.json"
        output.write_text(json.dumps(report, indent=2) + "\n")
        protect_file(output)
        print(json.dumps({"status":report["status"],"report":str(output),"failure":report.get("failure")}),flush=True)
    return int(report["status"]!="passed")

if __name__ == "__main__":
    raise SystemExit(main())
