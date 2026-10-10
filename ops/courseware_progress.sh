set -euo pipefail
docker exec -i -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
from workbench.config import Config
from workbench.service import Workbench
from workbench.storage import encode
w=Workbench(Config.load(home=Path('/opt/data/profiles/teacher-workbench-demo')))
for j in w.jobs.list()['jobs']:
 if j['kind']!='courseware' or j['id']=='job_f5765051ae984098':continue
 print('JOB',encode(j))
 folder=w.store.root/'drafts'/j['id']
 print('FILES', [(str(p.relative_to(folder)),p.stat().st_size) for p in folder.rglob('*') if p.is_file()][:35])
 for name in ['hermes.log','validation.md','worker.log']:
  p=folder/name
  if p.exists():print(name,p.read_text(errors='replace')[-1800:])
PY
