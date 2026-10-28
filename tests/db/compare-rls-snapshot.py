#!/usr/bin/env python3
"""Require exactly the reviewed 68 identity predicate changes, nothing else.

Capture both inputs with rls-snapshot.sql using psql -X -A -t. No DB/network
access occurs here; the caller must use the guarded disposable-local runner.
"""
import argparse
import json
from pathlib import Path


def normalized(expression):
    return None if expression is None else "".join(expression.split()).lower()


def compare(before, after, manifest):
    required = {
        "version", "policies", "relations", "columns", "functions", "schemas",
        "default_privileges", "roles", "memberships", "constraints", "triggers", "extensions",
    }
    if before.get("version") != 1 or after.get("version") != 1:
        raise ValueError("Unsupported catalog snapshot version")
    if set(before) != required or set(after) != required:
        raise ValueError("Catalog snapshot shape changed or required metadata is missing")
    for key in before.keys() - {"policies"}:
        if before[key] != after[key]:
            raise ValueError(f"Unexpected catalog change: {key}")
    key = lambda p: (p["schema"], p["table_name"], p["name"])
    old = {key(p): p for p in before["policies"]}
    new = {key(p): p for p in after["policies"]}
    if len(old) != len(before["policies"]) or len(new) != len(after["policies"]):
        raise ValueError("Duplicate policy identifiers")
    if old.keys() != new.keys():
        raise ValueError("A policy was created or removed")
    expected = {("public", p["table"], p["policy"]): p for p in manifest}
    if len(manifest) != 68 or len(expected) != 68:
        raise ValueError("Expected exactly 68 distinct reviewed policies")
    if not expected.keys() <= old.keys():
        raise ValueError("A reviewed policy is missing")
    changed = []
    expressions = {"using_expression", "check_expression"}
    for identifier in sorted(old):
        left, right = old[identifier], new[identifier]
        if identifier not in expected:
            if left != right:
                raise ValueError(f"Unrelated policy changed: {identifier}")
            continue
        item = expected[identifier]
        if left.keys() != right.keys():
            raise ValueError(f"Policy shape changed: {identifier}")
        for field in left.keys() - expressions:
            if left[field] != right[field]:
                raise ValueError(f"Policy authorization metadata changed: {identifier} {field}")
        if left["command"] != item["command"]:
            raise ValueError(f"Reviewed command changed: {identifier}")
        active = set()
        if item["command"] in ("r", "w", "d"):
            active.add("using_expression")
        if item["command"] in ("a", "w"):
            active.add("check_expression")
        for field in expressions:
            column = item["column"]
            wanted_old = f"({column}=auth.uid())" if field in active else None
            wanted_new = f"({column}=(selectauth.uid()asuid))" if field in active else None
            if normalized(left[field]) != wanted_old:
                raise ValueError(f"Unexpected original predicate: {identifier} {field}")
            if normalized(right[field]) != wanted_new:
                raise ValueError(f"Unexpected optimized predicate: {identifier} {field}")
        if left == right:
            raise ValueError(f"Reviewed policy was not optimized: {identifier}")
        changed.append({"schema": identifier[0], "table": identifier[1], "policy": identifier[2]})
    return {
        "status": "passed", "changed_policy_count": len(changed),
        "changed_policies": changed,
        "unchanged_policy_count": len(old) - len(changed),
        "unchanged_catalog_sections": sorted(before.keys() - {"policies", "version"}),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Refusing to overwrite earlier comparison evidence")
    manifest = json.loads(Path(__file__).with_name("rls-performance-manifest.json").read_text())
    try:
        result = compare(json.loads(args.before.read_text()), json.loads(args.after.read_text()), manifest)
    except (ValueError, KeyError, TypeError) as exc:
        result = {"status": "failed", "reason": str(exc)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as out:
        out.write(json.dumps(result, indent=2) + "\n")
    args.output.chmod(0o600)
    print(json.dumps({k: v for k, v in result.items() if k != "changed_policies"}))
    if result["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
