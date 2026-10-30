"""Adversarial cost transactions against the approved disposable Docker DB only.

No credentials or remote URLs are accepted. Start the task-specific local stack,
apply the validated schema, then run with --allow-disposable-local. All fixtures
are synthetic; only the exact fixture identity is removed during cleanup.
"""
import argparse
import json
import os
import selectors
import shutil
import subprocess
import time
import uuid

CONTAINER = "supabase_db_rentview-local-test"
REPLAY_CONTAINER = "supabase_db_rentview-migration-replay"
FOLLOWUP_CONTAINER = "supabase_db_rentview-review-followup"
ALLOWED_CONTAINERS = frozenset((CONTAINER, REPLAY_CONTAINER, FOLLOWUP_CONTAINER))
OWNER = "a1000000-0000-4000-8000-000000000001"
PROPERTY = "a2000000-0000-4000-8000-000000000001"
JOBS = [f"a3000000-0000-4000-8000-{i:012d}" for i in range(1, 4)]
INVOICES = [f"a4000000-0000-4000-8000-{i:012d}" for i in range(1, 4)]


class LocalDB:
    def __init__(self, container=CONTAINER):
        if container not in ALLOWED_CONTAINERS:
            raise RuntimeError("Refusing an unapproved database container; no database contacted")
        self.container = container
        docker = shutil.which("docker")
        if not docker:
            raise RuntimeError("Docker client unavailable; no database contacted")
        self.prefix = [docker, "--host=unix:///var/run/docker.sock"]
        self.env = os.environ.copy()
        for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
            self.env.pop(key, None)
        result = subprocess.run(self.prefix + ["inspect", "--type", "container", "--format", "{{.Name}}", self.container],
                                env=self.env, capture_output=True, text=True, timeout=10)
        if result.returncode or result.stdout.strip() != "/" + self.container:
            raise RuntimeError("Expected disposable local container is unavailable; no SQL sent")

    def command(self):
        return self.prefix + ["exec", "--interactive", self.container, "psql", "--no-psqlrc", "--quiet",
                              "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"]

    def _execute_sql(self, command, statement, expected_state=None, expected_message=None):
        result = subprocess.run(command, env=self.env, input="\\set VERBOSITY verbose\nset plpgsql.check_asserts=on;\n" + statement,
                                capture_output=True, text=True, timeout=20)
        if expected_state:
            if result.returncode == 0 or expected_state not in result.stderr or (expected_message is not None and expected_message not in result.stderr):
                raise AssertionError(f"Expected SQLSTATE {expected_state}; exit={result.returncode}; {result.stderr[:1500]}")
        elif result.returncode:
            raise AssertionError(result.stderr[:1500])
        return result.stdout.strip()

    def sql(self, statement, expected_state=None, expected_message=None):
        return self._execute_sql(self.command(), statement, expected_state, expected_message)

    def sql_as_storage_owner(self, statement, expected_state=None, expected_message=None):
        """Fixed authorized local owner, not a caller-selected database role.

        This connects as the actual platform Storage owner inside the already
        allowlisted disposable container. It never SET ROLEs, grants privileges,
        accepts credentials/URLs, or executes against a hosted target.
        """
        command = self.command()
        command[command.index("-U") + 1] = "supabase_storage_admin"
        return self._execute_sql(command, statement, expected_state, expected_message)

    def actor(self):
        return (f"begin; set local statement_timeout='12s'; set local role authenticated;\n"
                f"select set_config('request.jwt.claim.sub','{OWNER}',true);\n"
                f"select set_config('request.jwt.claims','{{\"role\":\"authenticated\",\"sub\":\"{OWNER}\"}}',true);\n")


class Transaction:
    def __init__(self, db, statement):
        self.process = subprocess.Popen(db.command(), env=db.env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        self.process.stdin.write(("\\set VERBOSITY verbose\n" + statement + "\n\\echo RENTVIEW_LOCK_HELD\n").encode())
        self.process.stdin.flush()
        received = b""
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 12
            while b"RENTVIEW_LOCK_HELD" not in received:
                events = selector.select(max(0, deadline - time.monotonic()))
                if not events:
                    self.close()
                    raise AssertionError("Timed out before transaction reached the lock barrier")
                part = os.read(self.process.stdout.fileno(), 4096)
                if not part:
                    stderr = self.process.stderr.read().decode(errors="replace")
                    self.close()
                    raise AssertionError("Transaction failed before barrier: " + stderr[:1500])
                received += part
        self.finished = False

    def commit(self):
        self.process.stdin.write(b"commit;\n\\q\n")
        self.process.stdin.flush()
        output, error = self.process.communicate(timeout=10)
        self.finished = True
        if self.process.returncode:
            raise AssertionError(error.decode(errors="replace")[:1500])
        return output.decode(errors="replace").strip()

    def close(self):
        if self.process.poll() is not None:
            return
        try:
            self.process.stdin.write(b"rollback;\n\\q\n")
            self.process.stdin.flush()
            self.process.communicate(timeout=8)
        except (BrokenPipeError, subprocess.TimeoutExpired):
            self.process.kill()
            self.process.communicate(timeout=5)


def complete(db, job, *, reuse=False, amount=10):
    return db.actor() + f"select public.complete_work_order('{job}',{amount},'USD','Synthetic concurrent completion',{str(reuse).lower()});\n"


def assert_true(db, expression, message):
    if db.sql("select (" + expression + ")::text;") != "true":
        raise AssertionError(message)


def wait_for_lock(db, app_name, *, advisory):
    deadline = time.monotonic() + 4
    predicate = "lower(wait_event)='advisory'" if advisory else "lower(wait_event)<>'advisory'"
    while time.monotonic() < deadline:
        if db.sql(f"select exists(select 1 from pg_stat_activity where application_name='{app_name}' and wait_event_type='Lock' and {predicate})::text;") == "true":
            return
        time.sleep(0.05)
    raise AssertionError("Transaction did not reach the expected server-side lock barrier")


def run(db):
    checks = []
    db.sql(f"begin; insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values('{OWNER}','cost-concurrency@example.test','{{}}',now());\n"
           f"insert into public.properties(id,owner_id,name) values('{PROPERTY}','{OWNER}','Synthetic concurrency building');\n" +
           "\n".join(f"insert into public.work_orders(id,owner_id,property_id,title) values('{job}','{OWNER}','{PROPERTY}','Synthetic concurrent job');" for job in JOBS) +
           f"\ninsert into public.expenses(id,owner_id,property_id,work_order_id,amount,currency) values('{INVOICES[2]}','{OWNER}','{PROPERTY}','{JOBS[2]}',5,'USD'); commit;")
    active = []
    try:
        # Completion posts but does not commit. A direct invoice must fail with
        # the retryable contention error rather than checking an old snapshot.
        transaction = Transaction(db, complete(db, JOBS[0]))
        active.append(transaction)
        db.sql(db.actor() + f"insert into public.expenses(owner_id,property_id,work_order_id,amount,currency) values('{OWNER}','{PROPERTY}','{JOBS[0]}',2,'USD'); commit;", expected_state="40001")
        transaction.commit()
        assert_true(db, f"(select count(*)=1 and sum(amount)=10 from public.expenses where work_order_id='{JOBS[0]}')", "Racing invoice changed a posted total")
        checks.append("completion rejects concurrent new invoice; posted total remains exact")

        # Reverse the order: an uncommitted invoice must be observed after
        # completion waits. Inspect the server's actual lock wait as a barrier.
        transaction = Transaction(db, db.actor() + f"insert into public.expenses(id,owner_id,property_id,work_order_id,amount,currency) values('{INVOICES[1]}','{OWNER}','{PROPERTY}','{JOBS[1]}',7,'USD');")
        active.append(transaction)
        app_name = "rentview_cost_wait_" + uuid.uuid4().hex
        waiter = subprocess.Popen(db.command(), env=db.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        waiter.stdin.write(("\\set VERBOSITY verbose\nset application_name='" + app_name + "';\n" + complete(db, JOBS[1], reuse=True, amount=0) + "commit;\n").encode())
        waiter.stdin.flush()
        try:
            wait_for_lock(db, app_name, advisory=True)
            transaction.commit()
            output, error = waiter.communicate(timeout=10)
            if waiter.returncode:
                raise AssertionError(error.decode(errors="replace")[:1500])
        finally:
            if waiter.poll() is None:
                waiter.kill()
                waiter.communicate(timeout=5)
        assert_true(db, f"(select cost=7 and completion_expense_id='{INVOICES[1]}' from public.work_orders where id='{JOBS[1]}')", "Completion missed an invoice committed before posting")
        checks.append("completion waits for invoice and posts its committed amount")

        # Pause DELETE after it has acquired the expense row but before the
        # production guard fires. Completion then acquires its cost lock and
        # waits for that row through the canonical expense FK. Releasing the
        # pause must make DELETE fail retryably, rather than complete a lock
        # cycle. This injected barrier exists only in this disposable fixture.
        db.sql(f"""create function rentview_private.fixture_pause_expense_delete()
returns trigger language plpgsql set search_path='' as $$ begin
 if old.id='{INVOICES[2]}' and current_setting('rentview_test.pause_delete',true)='on' then
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rentview-fixture-delete-barrier',614));
 end if;
 return old;
end $$;
create trigger aaa_rentview_fixture_pause_delete before delete on public.expenses
for each row execute function rentview_private.fixture_pause_expense_delete();""")
        barrier = Transaction(db, "begin; select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rentview-fixture-delete-barrier',614));")
        active.append(barrier)
        delete_name = "rentview_cost_delete_" + uuid.uuid4().hex
        complete_name = "rentview_cost_complete_" + uuid.uuid4().hex
        deleter = subprocess.Popen(db.command(), env=db.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        completer = None
        try:
            deleter.stdin.write(("\\set VERBOSITY verbose\nset application_name='" + delete_name + "';\n" + db.actor() +
                                 f"set local rentview_test.pause_delete='on'; delete from public.expenses where id='{INVOICES[2]}'; commit;\n").encode())
            deleter.stdin.flush()
            wait_for_lock(db, delete_name, advisory=True)
            completer = subprocess.Popen(db.command(), env=db.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            completer.stdin.write(("\\set VERBOSITY verbose\nset application_name='" + complete_name + "';\n" + complete(db, JOBS[2], reuse=True, amount=0) + "commit;\n").encode())
            completer.stdin.flush()
            wait_for_lock(db, complete_name, advisory=False)
            barrier.commit()
            output, error = deleter.communicate(timeout=10)
            if deleter.returncode == 0 or "40001" not in error.decode(errors="replace"):
                raise AssertionError("Racing deletion did not fail with retryable contention: " + error.decode(errors="replace")[:1500])
            output, error = completer.communicate(timeout=10)
            if completer.returncode:
                raise AssertionError("Completion failed after retryable delete: " + error.decode(errors="replace")[:1500])
        finally:
            barrier.close()
            for process in (deleter, completer):
                if process and process.poll() is None:
                    process.kill()
                    process.communicate(timeout=5)
            db.sql("drop trigger aaa_rentview_fixture_pause_delete on public.expenses; drop function rentview_private.fixture_pause_expense_delete();")
        assert_true(db, f"(select cost=5 and completion_expense_id='{INVOICES[2]}' from public.work_orders where id='{JOBS[2]}')", "Concurrent deletion broke the canonical expense")
        checks.append("concurrent invoice deletion fails retryably without deadlock")
        return checks
    finally:
        for transaction in active:
            transaction.close()
        db.sql("drop trigger if exists aaa_rentview_fixture_pause_delete on public.expenses; drop function if exists rentview_private.fixture_pause_expense_delete();")
        db.sql(f"begin; delete from auth.users where id='{OWNER}'; set constraints all immediate; commit;")
        assert_true(db, f"not exists(select 1 from auth.users where id='{OWNER}')", "Synthetic concurrency identity was not cleaned up")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-disposable-local", action="store_true")
    arguments = parser.parse_args()
    if not arguments.allow_disposable_local:
        parser.error("Explicit --allow-disposable-local is required; no database contacted")
    checks = run(LocalDB())
    print(json.dumps({"status": "passed", "checks": checks, "fixture_cleanup": "passed"}, indent=2))


if __name__ == "__main__":
    main()
