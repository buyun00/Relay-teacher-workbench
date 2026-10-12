set -euo pipefail
docker exec --user hermes -i -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
from workbench.config import Config
from workbench.service import Workbench
from workbench.courseware import Courseware
from workbench.storage import encode
w=Workbench(Config.load(home=Path('/opt/data/profiles/teacher-workbench-demo')))
c=Courseware(w.store)
j=c.prepare('artifact_7b770d16c8f54078','4页16:9白底课堂PPT，公式可编辑，正文字号至少28，原生点击分步揭示答案，逐页过渡及教师备注。')['job']
print(encode(c.run(j['id'])))
PY
