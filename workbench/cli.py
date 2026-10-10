"""Operator CLI. Model access goes through the native plugin, not free SQL."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from .config import Config, WorkbenchError
from .service import Workbench
from .storage import Store, encode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--home", type=Path)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    call = sub.add_parser("call")
    call.add_argument("tool")
    call.add_argument("--json", dest="payload")
    call.add_argument("--file", type=Path)
    call.add_argument("--teacher-message")
    call.add_argument("--session", default="operator")
    message = sub.add_parser("message")
    message.add_argument("text")
    message.add_argument("--session", default="operator")
    sub.add_parser("backup")
    sub.add_parser("export")
    deletion = sub.add_parser("delete-scope")
    deletion.add_argument("--lesson", action="append", default=[])
    deletion.add_argument("--exam", action="append", default=[])
    deletion.add_argument("--confirmation")
    sub.add_parser("purge")
    retry = sub.add_parser("retry-job")
    retry.add_argument("job_id")
    retry.add_argument("--external-checked", action="store_true")
    retry.add_argument("--reason", required=True)
    restore = sub.add_parser("restore")
    restore.add_argument("backup", type=Path)
    restore.add_argument("destination", type=Path)
    args = parser.parse_args()
    if args.command == "restore":
        return Store.restore(args.backup, args.destination)
    workbench = Workbench(Config.load(args.root, args.home))
    if args.command == "status":
        return workbench.query.coverage()
    if args.command == "message":
        return workbench.facts.message(args.text, args.session, "operator")
    if args.command == "backup":
        return workbench.store.backup()
    if args.command == "retry-job":
        return workbench.jobs.retry(args.job_id,args.external_checked,args.reason)
    if args.command in {"export", "delete-scope", "purge"}:
        from .maintenance import Maintenance
        ops = Maintenance(workbench.store)
        if args.command == "export": return ops.export()
        if args.command == "purge": return ops.purge()
        if args.confirmation: return ops.delete(args.lesson, args.exam, args.confirmation)
        return ops.plan(args.lesson, args.exam)
    if args.file:
        payload = json.loads(args.file.read_text(encoding="utf-8-sig"))
    elif args.payload:
        payload = json.loads(args.payload)
    else:
        payload = json.load(sys.stdin)
    context = {}
    if args.teacher_message:
        context["message_id"] = workbench.facts.message(args.teacher_message, args.session, "operator")["id"]
    return workbench.invoke(args.tool, payload, context)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(encode(main()))
    except (WorkbenchError, TypeError, KeyError, OSError, ValueError, subprocess.SubprocessError) as exc:
        print(encode({"ok": False, "error": str(exc)}), file=sys.stderr)
        raise SystemExit(1)
