set -euo pipefail
install -m 600 /home/lin-server/teacher-workbench-upload/fictional-function-lesson.wav /srv/ai/hermes-agent/data/teacher-workspaces/fictional-demo/inbox/fictional-function-lesson.wav
docker exec -i -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
from workbench.config import Config
from workbench.service import Workbench
from workbench.storage import encode,atomic_write
w=Workbench(Config.load(home=Path('/opt/data/profiles/teacher-workbench-demo')))
w.facts.lesson('demo_audio','函数定义域录音测试',occurred_at='2026-10-10')
asset=w.speech.import_audio(str(w.store.root/'inbox/fictional-function-lesson.wav'),'demo_audio')
job=w.speech.submit(asset['job']['id'],speakers=1)
atomic_write(w.store.root/'pilot-asr-job.json',encode({'job_id':job['id']}).encode())
print(encode({'health':w.speech.health(),'asset_id':asset['id'],'job':job}))
PY
