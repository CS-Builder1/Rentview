"""Check API routing and backend-only RPCs on disposable local Supabase.

This verifies the Data API boundary independently of strict pg_net SQL privilege
assertions. It does not claim that database ACLs are safe. No URL
is supplied to an HTTP RPC, and no external provider is used.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import signal
from uuid import uuid4

from local_e2e import LocalAPI, private_credentials, protect_file


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials-file", type=Path, required=True)
    parser.add_argument("--allow-disposable-local", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--check-target", action="store_true")
    args = parser.parse_args(argv)
    if not args.allow_disposable_local:
        parser.error("Explicit disposable-local opt-in is required; no service contacted.")
    try:
        target = private_credentials(args.credentials_file)
    except (ValueError, OSError, json.JSONDecodeError) as failure:
        parser.error(str(failure))
    if args.check_target:
        print(json.dumps({"target": "loopback only", "credentials": "owner-only file", "contacted": False}))
        return 0

    os.umask(0o077)
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Preserve previous reports, including failures; never follow an output link.
    output_fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    secret_values = [target["anon"], target["service"]]
    api = LocalAPI(target, secret_values)
    users = []
    result = {
        "scope": "synthetic disposable-local Auth/Data API boundary only",
        "status": "running",
        "checks": [],
        "sql_acl_status": "not tested by this API runner; inspect separate strict SQL boundary and repair evidence",
        "not_run": ["hosted grants/exposure", "SQL ACL repair/assertions in this API runner", "provider delivery"],
    }
    current_check = "synthetic_owner_setup"

    def record(label, actor, status, code=None):
        result["checks"].append({"name": label, "actor": actor, "http_status": status, "code": code})

    def deny(label, actor, token, method, path, headers, expected_status, expected_code):
        nonlocal current_check
        current_check = label + ":" + actor
        status, body = api.request(method, path, token=token, body={} if method == "POST" else None, headers=headers)
        code = body.get("code") if isinstance(body, dict) else None
        # Report only HTTP/error codes. Never copy arbitrary bodies or secrets.
        record(label, actor, status, code)
        assert status == expected_status and code == expected_code, "Unexpected API boundary status/code."

    try:
        run_id = uuid4().hex[:12]
        email = f"rentview-boundary-{run_id}@example.test"
        password = "Rv!" + secrets.token_urlsafe(24)
        uid = api.admin_user(email, password, "Fixture backend boundary owner")
        users.append(uid)
        login_uid, token = api.login(email, password)
        assert login_uid == uid, "Synthetic owner login returned a different identity."

        current_check = "normal_profile_api"
        status, rows = api.request("GET", "/rest/v1/profiles?select=id", token=token)
        assert status == 200 and rows == [{"id": uid}], "The ordinary owner Data API did not return its exact profile."
        record("normal_profile_api", "authenticated", status)

        for actor, actor_token in [("anon", None), ("authenticated", token)]:
            deny("net_read_profile_refused", actor, actor_token, "GET", "/rest/v1/http_request_queue?select=id",
                 {"Accept-Profile": "net"}, 406, "PGRST106")
            # Empty arguments intentionally omit url. A routing regression must
            # never turn this probe into an actual HTTP dispatch.
            deny("net_write_profile_refused", actor, actor_token, "POST", "/rest/v1/rpc/http_post",
                 {"Content-Profile": "net"}, 406, "PGRST106")
            # PostgREST maps SQLSTATE42501 to401 for the anonymous role and403
            # for an authenticated user. Keep each actor's exact expectation.
            denied_status = 401 if actor == "anon" else 403
            for function in ["push_hook_config", "dispatch_due_notifications", "dispatch_due_reminders"]:
                deny("backend_rpc_refused:" + function, actor, actor_token, "POST", "/rest/v1/rpc/" + function,
                     {}, denied_status, "42501")
        result["status"] = "passed"
    except Exception as failure:
        result["status"] = "failed"
        # Fixed labels and exception types only: even unexpected server bodies,
        # URLs, credentials or secret-returning RPC results cannot reach output.
        result["failure"] = {"check": current_check, "exception_type": type(failure).__name__}
    finally:
        cleanup = [api.cleanup_synthetic_user(uid) for uid in reversed(users)]
        cleanup_errors = sum(item["status"] != "deleted" for item in cleanup)
        result["cleanup"] = {"synthetic_users": len(users), "errors": cleanup_errors, "details": cleanup}
        if cleanup_errors:
            result["status"] = "failed"
            result.setdefault("failure", {"check": "synthetic_cleanup", "exception_type": "CleanupFailure"})
        with os.fdopen(output_fd, "w") as output:
            json.dump(result, output, indent=2)
            output.write("\n")
        protect_file(args.output)
        print(json.dumps({"status": result["status"], "checks": len(result["checks"]), "failure": result.get("failure"), "result_file": str(args.output)}))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    def timeout(_signal, _frame):
        raise TimeoutError("Local backend-boundary wall-clock limit reached.")
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(180)
    raise SystemExit(main())
