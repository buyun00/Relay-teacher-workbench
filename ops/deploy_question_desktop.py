"""Run in the Hermes container against a bank-only staging directory.

Preserves unrelated live ingress changes. Restart only teacher-recordings.service
after this script succeeds; never restart the container or Hermes core.
"""
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

stage=Path(sys.argv[1])
target=Path('/opt/data/profiles/teacher-workbench/plugins/teacher-workbench')
database=Path('/opt/data/teacher-workspaces/teacher/database/workbench.sqlite')
backup=stage/('desktop-backup-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
with sqlite3.connect(database) as db:
    if db.execute("SELECT count(*) FROM desktop_turns WHERE state IN ('queued','running','cancelling')").fetchone()[0] or db.execute("SELECT count(*) FROM jobs WHERE state='running'").fetchone()[0]:
        raise SystemExit('Receiver is busy; retry deployment when idle')
    backup.mkdir(parents=True)
    with sqlite3.connect(backup/'workbench.sqlite') as dest: db.backup(dest)
source=(target/'workbench/ingress.py').read_text()
anchor='            elif parsed.path == "/v1/organization" and self.command in {"GET", "POST"}:\n'
if 'parsed.path == "/v1/question-bank"' not in source:
    assert source.count(anchor)==1
    source=source.replace(anchor,'            elif parsed.path == "/v1/question-bank" and self.command == "POST":\n                from .question_desktop import command\n                result = command(ingress.store, self.chat_payload())\n'+anchor)
compile(source,'ingress.py','exec')
for name in ('question_bank.py','question_desktop.py'):
    body=(stage/name).read_text(); compile(body,name,'exec')
    if (target/'workbench'/name).exists(): shutil.copy2(target/'workbench'/name,backup/name)
    shutil.copy2(stage/name,target/'workbench'/name)
shutil.copy2(target/'workbench/ingress.py',backup/'ingress.py')
(target/'workbench/ingress.py').write_text(source)
print('Patched bank desktop API. Backup:',backup)
