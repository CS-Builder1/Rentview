"""Verify lease messaging and field repair dispatch in four independent browsers.

The owner prepares a synthetic property and delegates to a separate manager.
The manager, resident and two contractors perform their work through the web UI.
"""
import argparse
import json
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, urlparse
from uuid import uuid4

from local_e2e import LOOPBACK, PNG, LocalAPI, local_url, poll, private_credentials, protect_file


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--credentials-file", type=Path, required=True)
    parser.add_argument("--allow-disposable-local", action="store_true", required=True)
    parser.add_argument("--output", type=Path, required=True, help="New or existing private results directory")
    parser.add_argument("--browser", default="/usr/bin/chromium")
    args = parser.parse_args()
    base = local_url(args.base_url, root=True)
    target = private_credentials(args.credentials_file)
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    run_id = uuid4().hex[:10]
    result_path = args.output / f"field-{run_id}.json"
    hidden = [target["anon"], target["service"]]
    api = LocalAPI(target, hidden)
    contexts = []
    pages = {}
    result = {"run": run_id, "status": "running", "checks": [], "blocked_hosts": [], "browser_errors": []}
    browser = playwright = None
    step = "fixture setup"

    def clean(value):
        text = str(value)
        for secret in sorted(hidden, key=len, reverse=True):
            if secret:
                text = text.replace(secret, "[fixture-secret]")
        return re.sub(r"eyJ[A-Za-z0-9_.-]{30,}", "[token]", text)[:1600]

    def checked(name):
        result["checks"].append(name)
        print(json.dumps({"passed": name}), flush=True)

    def person(label):
        email = f"rentview-field-{run_id}-{label}@example.test"
        password = "Rv!" + secrets.token_urlsafe(24)
        hidden.append(password)
        uid = api.admin_user(email, password, "Fixture " + label)
        login_id, token = api.login(email, password)
        assert uid == login_id
        return {"id": uid, "email": email, "token": token, "password": password}

    def login(actor, label, phone=False):
        context = browser.new_context(
            viewport={"width": 412 if phone else 1280, "height": 915},
            timezone_id="UTC", locale="en-US", service_workers="block",
        )
        contexts.append(context)

        def network(route):
            url = urlparse(route.request.url)
            if url.hostname in LOOPBACK or url.scheme in {"data", "blob"}:
                route.continue_()
            else:
                result["blocked_hosts"].append(url.hostname)
                route.abort("blockedbyclient")

        def socket(route):
            host = urlparse(route.url).hostname
            if host in LOOPBACK:
                route.connect_to_server()
            else:
                result["blocked_hosts"].append(host)
                route.close()

        context.route("**/*", network)
        context.route_web_socket("**/*", socket)
        page = context.new_page()
        pages[label] = page
        page.set_default_timeout(30000)
        page.on("pageerror", lambda error: result["browser_errors"].append(clean(error)))
        def response_error(response):
            if response.status < 400: return
            item = {"actor":label, "path":urlparse(response.url).path, "status":response.status}
            try:
                data = response.json()
                item["code"] = data.get("code") or data.get("error_code")
                item["detail"] = clean(data.get("message") or data.get("msg") or data.get("error_description") or "")
            except Exception: pass
            result.setdefault("http_errors",[]).append(item)
        page.on("response",response_error)
        page.on("dialog", lambda dialog: dialog.accept())
        goto(page, "/login")
        page.get_by_label("Email", exact=True).fill(actor["email"])
        page.get_by_label("Password", exact=True).fill(actor["password"])
        with page.expect_response(lambda response: urlparse(response.url).path=="/auth/v1/token" and response.request.method=="POST") as auth:
            click(page, "Sign in")
        assert auth.value.ok, f"{label} sign-in returned HTTP {auth.value.status}"
        page.wait_for_url(lambda url: urlparse(url).path.rstrip("/") not in {"/login", "/callback"})
        return page

    def goto(page, route):
        page.goto(base + route, wait_until="domcontentloaded")

    def click(page, name):
        page.get_by_role("button", name=name, exact=True).click()

    def event(actor, title, href):
        return next((e for e in api.rpc("inbox_activity", {}, actor["token"])
                     if e["title"] == title and e["href"] == href), None)

    def follow_event(page, actor, title, href):
        # Click the real alert, then verify the recipient-specific persisted receipt.
        poll(lambda: event(actor, title, href), pump=page.wait_for_timeout)
        if urlparse(page.url).path != "/inbox":
            home = "/tenant" if actor is renter else "/" if actor is manager else "/contractor"
            goto(page, home)
            page.get_by_role("button", name=re.compile(r"^Inbox(?: · [0-9]+ unread)?$")).click()
        page.get_by_role("button").filter(has=page.get_by_text(title, exact=True)).first.click()
        page.wait_for_url(lambda url: urlparse(url).path == href)
        poll(lambda: event(actor, title, href)["read_at"], pump=page.wait_for_timeout)

    def send(page, body):
        page.get_by_label("Message", exact=True).fill(body)
        click(page, "Send message")
        expect(page.get_by_text(body, exact=True).filter(visible=True)).to_be_visible()

    def propose(page, action, start, end):
        click(page, action)
        page.get_by_label("Visit starts", exact=True).fill(start.strftime("%Y-%m-%d %H:%M"))
        page.get_by_label("Visit ends", exact=True).fill(end.strftime("%Y-%m-%d %H:%M"))
        click(page, "Send visit proposal")

    try:
        from playwright.sync_api import expect, sync_playwright
        owner, manager, renter, first, second = [person(role) for role in
            ["owner", "manager", "resident", "first-plumber", "second-plumber"]]
        prop = api.insert("properties", {"owner_id": owner["id"], "name": "Field House " + run_id},
                          owner["token"])
        unit = api.insert("units", {"owner_id": owner["id"], "property_id": prop["id"], "label": "2B"},
                          owner["token"])
        lease = api.insert("leases", {"owner_id": owner["id"], "unit_id": unit["id"],
                          "tenant_name": "Field Resident", "tenant_email": renter["email"], "status": "active"}, owner["token"])
        invitation = api.rpc("create_tenant_invite", {"p_lease_id": lease["id"], "p_email": renter["email"]}, owner["token"])
        hidden.append(invitation["code"])
        api.rpc("claim_tenant_invite", {"invite_code": invitation["code"]}, renter["token"])
        api.rpc("invite_property_manager", {"p_property": prop["id"], "p_email": manager["email"]}, owner["token"])
        api.rpc("accept_manager_invitation", {"p_property": prop["id"]}, manager["token"])
        vendors = []
        for name, worker in [("First Plumbing", first), ("Second Plumbing", second)]:
            vendor = api.insert("vendors", {"owner_id": owner["id"], "name": name + " " + run_id,
                                "property_id": prop["id"], "email": worker["email"]}, owner["token"])
            code = api.rpc("create_contractor_invite", {"p_vendor": vendor["id"]}, owner["token"])
            hidden.append(code)
            api.rpc("claim_contractor_invite", {"p_code": code}, worker["token"])
            vendors.append(vendor)

        step = "four browser sign-ins"
        playwright = sync_playwright().start()
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True,
                                              args=["--no-sandbox", "--disable-background-networking"])
        resident_page = login(renter, "resident", True)
        staff_page = login(manager, "manager")
        worker_one = login(first, "first", True)
        worker_two = login(second, "second", True)
        expect(resident_page.get_by_text("My leases", exact=True).filter(visible=True)).to_be_visible()
        expect(staff_page.get_by_role("button", name="Open Work", exact=True).filter(visible=True)).to_be_visible()
        for page in [worker_one, worker_two]:
            expect(page.get_by_text("Assigned jobs", exact=True).filter(visible=True)).to_be_visible()
        checked("Four isolated sign-ins route each actor to their workspace")

        step = "lease conversation and receipts"
        question = "Can we renew our lease in March? " + run_id
        answer = "Yes. I will send the renewal dates tomorrow."
        thread = "/conversation/" + lease["id"]
        click(resident_page, "Message property management")
        send(resident_page, question)
        # Leave the conversation so the resident actually misses the reply.
        click(resident_page, "Inbox")
        assert not api.select("maintenance_requests", renter["token"], lease_id=lease["id"])
        follow_event(staff_page, manager, "New lease message", thread)
        expect(staff_page.get_by_text(question, exact=True).filter(visible=True)).to_be_visible()
        send(staff_page, answer)
        receipt = poll(lambda: event(renter, "New lease message", thread), pump=resident_page.wait_for_timeout)
        assert receipt["read_at"] is None
        follow_event(resident_page, renter, "New lease message", thread)
        expect(resident_page.get_by_text(answer, exact=True).filter(visible=True)).to_be_visible()
        stored = api.rpc("lease_thread", {"p_lease":lease["id"],"p_resident":renter["id"]}, manager["token"])
        assert {(m["body"],m["sender_id"]) for m in stored} == {(question,renter["id"]),(answer,manager["id"])}
        checked("General lease question and delegated manager reply reach separate inboxes with saved receipts")

        step = "resident files leak"
        goto(resident_page, "/tenant")
        click(resident_page, "Report a repair")
        title = "Kitchen sink leaking " + run_id
        resident_page.get_by_label("What's wrong", exact=True).fill(title)
        resident_page.get_by_label("Details", exact=True).fill("Water drips beneath the kitchen sink.")
        click(resident_page, "Plumbing")
        click(resident_page, "High")
        resident_page.get_by_label("When can someone visit? (optional)", exact=True).fill("Weekday mornings")
        click(resident_page, "Submit request")
        resident_page.wait_for_url(re.compile(r".*/tenant/request/[0-9a-f-]+$"))
        request_id = resident_page.url.rsplit("/",1)[-1]
        request = lambda: api.select("maintenance_requests", renter["token"], id=request_id)[0]
        assert request()["category"]=="plumbing" and request()["urgency"]=="high" and request()["unit_id"]==unit["id"]
        checked("Resident reports a specific high-priority plumbing leak against the linked unit")

        step = "delegated manager converts and assigns leak"
        follow_event(staff_page,manager,"New repair request","/request/"+request_id)
        click(staff_page,"Convert to work order")
        staff_page.wait_for_url(re.compile(r".*/work-order/[0-9a-f-]+$"))
        job_id = staff_page.url.rsplit("/",1)[-1]
        job = lambda: api.select("dispatch_jobs",manager["token"],work_order_id=job_id)[0]
        assert request()["work_order_id"]==job_id
        def assign(button, vendor):
            click(staff_page,button)
            click(staff_page,vendor["name"])
            staff_page.get_by_label("Visit instructions shared with the contractor and tenant",exact=True).fill("Ring the unit doorbell.")
            click(staff_page,"Save assignment")
            poll(lambda: job()["vendor_id"]==vendor["id"],pump=staff_page.wait_for_timeout)
        assign("Assign contractor",vendors[0])
        checked("Delegated manager converts the request and assigns the first contractor")

        step = "decline and reassign"
        contractor_url = "/contractor/job/"+job_id
        follow_event(worker_one,first,"Repair assignment updated",contractor_url)
        expect(worker_one.get_by_text(title,exact=True).filter(visible=True)).to_be_visible()
        click(worker_one,"Decline job")
        poll(lambda: job()["assignment_status"]=="declined",pump=worker_one.wait_for_timeout)
        follow_event(staff_page,manager,"Contractor declined the repair","/work-order/"+job_id)
        assign("Change assignment or instructions",vendors[1])
        assert not api.rpc("my_dispatch_jobs",{},first["token"])
        follow_event(worker_two,second,"Repair assignment updated",contractor_url)
        click(worker_two,"Accept job")
        poll(lambda: job()["assignment_status"]=="accepted",pump=worker_two.wait_for_timeout)
        follow_event(worker_one,first,"Assignment withdrawn","/contractor")
        expect(worker_one.get_by_text("No assigned jobs",exact=True).filter(visible=True)).to_be_visible()
        checked("First contractor declines; reassignment withdraws prior access and the second contractor accepts")

        step = "tenant and contractor reschedule and confirm"
        day = (datetime.now(timezone.utc)+timedelta(days=3)).replace(hour=9,minute=0,second=0,microsecond=0)
        propose(worker_two,"Propose visit window",day,day+timedelta(hours=1))
        poll(lambda: job()["visit_status"]=="proposed",pump=worker_two.wait_for_timeout)
        resident_url = "/tenant/request/"+request_id
        follow_event(resident_page,renter,"Visit proposed",resident_url)
        revised = day+timedelta(days=1)
        propose(resident_page,"Propose a different time",revised,revised+timedelta(hours=2))
        poll(lambda: datetime.fromisoformat(job()["visit_start"])==revised,pump=resident_page.wait_for_timeout)
        follow_event(worker_two,second,"New visit time proposed",contractor_url)
        click(worker_two,"Confirm visit window")
        poll(lambda: job()["visit_status"]=="confirmed",pump=worker_two.wait_for_timeout)
        follow_event(resident_page,renter,"Visit confirmed",resident_url)
        expect(resident_page.get_by_text("Confirmed visit",exact=True).filter(visible=True)).to_be_visible()
        assert datetime.fromisoformat(job()["visit_end"])==revised+timedelta(hours=2)
        checked("Resident counters the proposed visit and the contractor confirms the revised UTC window")

        step = "worker completes with proof"
        click(worker_two,"Start repair")
        poll(lambda: request()["status"]=="in_progress",pump=worker_two.wait_for_timeout)
        notes = "Replaced the sink trap washer and tested for drips."
        worker_two.get_by_label("Completion notes",exact=True).fill(notes)
        with worker_two.expect_file_chooser() as chooser:
            click(worker_two,"Add completion photo")
        chooser.value.set_files({"name":"repair-proof.png","mimeType":"image/png","buffer":PNG})
        expect(worker_two.get_by_role("button",name="Remove photo 1",exact=True).filter(visible=True)).to_be_visible()
        click(worker_two,"Submit completed repair")
        poll(lambda: request()["status"]=="resolved",pump=worker_two.wait_for_timeout)
        completed = job()
        assert completed["assignment_status"]=="completed" and completed["completion_notes"]==notes
        assert len(completed["completion_photos"])==1
        path = completed["completion_photos"][0]
        image = api.ok("GET","/storage/v1/object/authenticated/dispatch-photos/"+quote(path,safe="/"),token=renter["token"])
        assert image.startswith((b"\x89PNG",b"\xff\xd8\xff",b"RIFF")), "Resident did not receive stored image bytes"
        goto(resident_page,resident_url)
        expect(resident_page.get_by_text(notes,exact=True).filter(visible=True)).to_be_visible()
        with resident_page.context.expect_page() as opened:
            click(resident_page,"View completion photo 1")
        proof_page = opened.value
        proof_page.wait_for_function("() => document.images.length === 1 && document.images[0].naturalWidth > 0")
        assert urlparse(proof_page.url).path.endswith("/dispatch-photos/"+path)
        proof_page.close()
        checked("Contractor records work, uploads proof, and the resident can see the notes and retrieve the photo")

        step = "resident rates then reopens repair"
        resident_page.get_by_role("radio",name="2 out of 5 stars",exact=True).click()
        click(resident_page,"Submit rating")
        poll(lambda: request()["rating"]==2,pump=resident_page.wait_for_timeout)
        reason = "The same pipe leaked again this evening."
        resident_page.get_by_label("What still needs attention?",exact=True).fill(reason)
        click(resident_page,"Reopen request")
        poll(lambda: request()["status"]=="acknowledged",pump=resident_page.wait_for_timeout)
        assert request()["work_order_id"]==job_id and request()["rating"] is None
        assert job()["assignment_status"]=="accepted"
        events = api.select("dispatch_history",manager["token"],work_order_id=job_id)
        assert any(e["event"]=="field_completed" and e["detail"]["completion_photos"]==[path] for e in events)
        assert any(e["event"]=="reopened" and e["detail"].get("prior_rating")==2 for e in events)
        follow_event(worker_two,second,"Resident reopened the repair",contractor_url)
        follow_event(staff_page,manager,"Repair reply","/request/"+request_id)
        expect(staff_page.get_by_text("Still not fixed: "+reason,exact=True).filter(visible=True)).to_be_visible()
        checked("Renter reopens the rated repair; staff and worker see the follow-up and original evidence stays in history")
        assert not result["browser_errors"] and not result["blocked_hosts"]
        result["status"]="passed"
    except Exception as error:
        result["status"]="failed"
        result["failure"]={"step":step,"type":type(error).__name__,"message":clean(error)}
        result["screens"]={}
        for label,page in pages.items():
            try: result["screens"][label]={"route":urlparse(page.url).path,"text":clean(page.locator("body").inner_text(timeout=1500))}
            except Exception: pass
    finally:
        for context in contexts:
            try: context.close()
            except Exception: pass
        if browser: browser.close()
        if playwright: playwright.stop()
        deleted=[api.cleanup_synthetic_user(uid) for uid in reversed(list(api.synthetic_users))]
        result["cleanup"]={"created":len(deleted),"deleted":sum(u["status"]=="deleted" for u in deleted),"errors":[u for u in deleted if u["status"]!="deleted"]}
        if result["cleanup"]["errors"]: result["status"]="failed"
        result_path.write_text(json.dumps(result,indent=2)+"\n")
        protect_file(result_path)
        print(json.dumps({"status":result["status"],"report":str(result_path),"failure":result.get("failure")}),flush=True)
    return int(result["status"]!="passed")

if __name__=="__main__":
    raise SystemExit(main())
