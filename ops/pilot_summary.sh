set -euo pipefail
docker exec -i -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import json
from workbench.config import Config
from workbench.service import Workbench
from workbench.storage import encode
w=Workbench(Config.load(home=Path('/opt/data/profiles/teacher-workbench-demo')))
with w.store.connect() as db:
 print('COUNTS',encode({name:db.execute('SELECT COUNT(*) FROM '+name).fetchone()[0] for name in ['lessons','students','transcripts','events','corrections','questions','artifacts','jobs','messages']}))
 print('EVENT',encode(w.facts.read_event('demo_event')))
 print('ARTIFACTS',encode([dict(r) for r in db.execute('SELECT id,kind,stale FROM artifacts')]))
for j in w.jobs.list()['jobs']:
 print('JOB',encode(j))
 if j['kind']=='courseware':
  folder=w.store.root/'drafts'/j['id']
  for name in ['worker.log','hermes.log','validation.md']:
   p=folder/name
   if p.exists(): print(name,p.read_text(errors='replace')[-2500:])
p=w.store.root/'pilot-correction.log'
if p.exists():print('CORRECTION_LOG',p.read_text()[-1500:])
PY
