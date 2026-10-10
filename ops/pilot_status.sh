set -euo pipefail
docker exec -i -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import json
from workbench.config import Config
from workbench.service import Workbench
from workbench.storage import encode
w=Workbench(Config.load(home=Path('/opt/data/profiles/teacher-workbench-demo')))
print('COVERAGE',encode(w.query.coverage()))
print('ARTIFACTS',encode(w.artifacts.list()))
print('EVENTS',encode(w.query.search('',student_id='demo_s02')) if w.query.coverage()['lesson_count']>=3 else '')
p=w.store.root/'pilot-asr-job.json'
if p.exists(): print('ASR',encode(w.speech.poll(json.loads(p.read_text())['job_id'])))
log=w.store.root/'pilot-native.log'
if log.exists(): print('NATIVE_LOG_TAIL',log.read_text()[-3500:])
PY
