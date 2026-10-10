set -euo pipefail
docker exec -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench hermes-agent /opt/hermes/.venv/bin/python -W error::ResourceWarning -m unittest discover -s tests -v
docker exec hermes-agent /opt/data/teacher-bin/teacher -z '请实际调用 teacher_context overview，只返回空间名称、已导入课次数和学生人数。不要导入验收材料。'
docker exec -i -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import tempfile
from workbench.config import Config
from workbench.service import Workbench
from workbench.storage import Store,encode
w=Workbench(Config.load(home=Path('/opt/data/profiles/teacher-workbench-demo')))
backup=w.store.backup()
with tempfile.TemporaryDirectory() as folder:
 dest=Path(folder)/'restored'
 Store.restore(Path(backup['path']),dest)
 restored=Workbench(Config(root=dest,workspace_id='fictional-demo'))
 assert restored.facts.read_event('demo_event')['student_id']=='demo_s02'
 assert restored.facts.read_event('demo_event')['revision']==2
 assert restored.query.questions(status='answered')['total']==1
 print('LIVE_BACKUP_RESTORE_OK')
 print('RESTORED_JOBS',encode({j['id']:j['state'] for j in restored.jobs.list()['jobs']}))
print('ASR_HEALTH',encode(w.speech.health()))
with w.store.connect() as db:
 print('DATABASE_CHECK',db.execute('PRAGMA integrity_check').fetchone()[0],list(db.execute('PRAGMA foreign_key_check')))
PY
