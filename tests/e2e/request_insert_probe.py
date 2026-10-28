"""Diagnose tenant INSERT versus INSERT RETURNING on disposable local Supabase.

Uses only task-created synthetic identities and the real Auth/Data API. No
schema changes, providers, email delivery or browser session injection.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
from urllib.parse import urlencode
from uuid import uuid4

from local_e2e import LocalAPI, private_credentials, protect_file


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials-file", type=Path, required=True)
    parser.add_argument("--allow-disposable-local", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.allow_disposable_local:
        parser.error("Explicit disposable-local opt-in is required; no service contacted.")
    target = private_credentials(args.credentials_file)
    os.umask(0o077)
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    secret_values = [target["anon"], target["service"]]
    api = LocalAPI(target, secret_values)
    users = []
    result = {"scope": "synthetic local API diagnostic only", "status": "running", "observations": []}
    run_id = uuid4().hex[:12]

    def principal(label):
        email = f"rentview-probe-{run_id}-{label}@example.test"
        password = "Rv!" + secrets.token_urlsafe(24)
        uid = api.admin_user(email, password, "Fixture request probe " + label)
        users.append(uid)
        _, token = api.login(email, password)
        return {"id": uid, "email": email, "token": token}

    try:
        owner, tenant = principal("owner"), principal("tenant")
        property_row = api.insert("properties", {"owner_id": owner["id"], "name": "Fixture request RETURNING probe"}, owner["token"])
        unit = api.insert("units", {"owner_id": owner["id"], "property_id": property_row["id"], "label": "Fixture probe unit"}, owner["token"])
        lease = api.insert("leases", {"owner_id": owner["id"], "unit_id": unit["id"], "tenant_name": "Fixture probe tenant", "tenant_email": tenant["email"], "status": "active"}, owner["token"])
        invitation = api.rpc("create_tenant_invite", {"p_lease_id": lease["id"], "p_email": tenant["email"]}, owner["token"])
        api.rpc("claim_tenant_invite", {"invite_code": invitation["code"]}, tenant["token"])
        view = api.select("tenant_lease_details", tenant["token"], lease_id=lease["id"])[0]
        scope = api.rpc("tenant_lease_matches", {"p_lease": view["lease_id"], "p_unit": view["unit_id"], "p_property": view["property_id"], "p_owner": view["owner_id"]}, tenant["token"])
        assert scope is True, "The probe did not establish an authorized active lease."
        result["scope_predicate"] = scope
        insert_outcomes = []
        for label, prefer, single in [("minimal", "return=minimal", False), ("representation", "return=representation", False), ("representation_single", "return=representation", True)]:
            row_id = str(uuid4())
            payload = {"id": row_id, "owner_id": view["owner_id"], "lease_id": view["lease_id"], "unit_id": view["unit_id"], "property_id": view["property_id"], "tenant_user_id": tenant["id"], "title": "Fixture authorized repair " + label, "description": "Matches the real browser submission fields.", "category": "general", "urgency": "medium"}
            headers = {"Prefer": prefer}
            if single:
                headers["Accept"] = "application/vnd.pgrst.object+json"
            path = "/rest/v1/maintenance_requests"
            if prefer == "return=representation":
                path += "?" + urlencode({"select": "id"})
            status, data = api.request("POST", path, token=tenant["token"], body=payload, headers=headers)
            owner_rows = api.select("maintenance_requests", owner["token"], id=row_id)
            tenant_rows = api.select("maintenance_requests", tenant["token"], id=row_id)
            observation = {"mode": label, "http_status": status, "code": data.get("code") if isinstance(data, dict) else None, "owner_visible_rows": len(owner_rows), "tenant_visible_rows": len(tenant_rows)}
            result["observations"].append(observation)
            insert_outcomes.append(status)
            if status == 201:
                assert len(owner_rows) == len(tenant_rows) == 1, "A successful insert was not visible to both authorized participants."
                assert owner_rows[0]["id"] == tenant_rows[0]["id"] == row_id, "A successful insert returned an unexpected stored record."
                if prefer == "return=representation":
                    expected = {"id": row_id} if single else [{"id": row_id}]
                    assert data == expected, "The insert representation did not return the submitted record ID."
                    observation["returned_id_matches"] = True
            if label == "minimal":
                assert status == 201 and len(owner_rows) == len(tenant_rows) == 1, "The minimal insert baseline failed."
            payload["id"] = str(uuid4())
            payload["tenant_user_id"] = owner["id"]
            rejected, error = api.request("POST", path, token=tenant["token"], body=payload, headers=headers)
            assert rejected == 403 and isinstance(error, dict) and error.get("code") == "42501", "A forged request participant was not refused by RLS."
        result["forged_participant"] = "refused for all three return modes"
        if insert_outcomes == [201, 403, 403]:
            result["status"] = "defect_reproduced"
        elif insert_outcomes == [201, 201, 201]:
            result["status"] = "passed"
        else:
            result["status"] = "inconclusive"
    except Exception as failure:
        result["status"] = "failed"
        # API helpers expose only method/path/status/error code. Never serialize
        # request headers, account credentials or arbitrary response bodies.
        message = str(failure)
        for value in secret_values:
            message = message.replace(value, "[fixture-secret]")
        result["error"] = message
    finally:
        cleanup_errors = 0
        for uid in reversed(users):
            try:
                api.ok("DELETE", "/auth/v1/admin/users/" + uid, admin=True)
            except Exception:
                cleanup_errors += 1
        result["cleanup_errors"] = cleanup_errors
        if cleanup_errors:
            result["status"] = "failed"
        args.output.write_text(json.dumps(result, indent=2))
        protect_file(args.output)
        print(json.dumps(result, indent=2))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
