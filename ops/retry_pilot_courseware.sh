set -euo pipefail
docker exec -i -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import os,json
from workbench.config import Config
from workbench.service import Workbench
from workbench.courseware import Courseware
from workbench.storage import encode
w=Workbench(Config.load(home=Path('/opt/data/profiles/teacher-workbench-demo')))
row=w.store.one('jobs','job_f5765051ae984098')
if row['state']=='needs_attention':
 if row['error']!='资料文件不存在或不能访问':raise SystemExit('Unexpected failure; inspect first')
 folder=w.store.root/'drafts'/row['id']
 if (folder/'lesson.pptx').exists(): raise SystemExit('Existing output; recover rather than rerun')
 pid=int(row['external_id'].split(':')[1])
 proc=Path('/proc')/str(pid)
 if proc.exists() and '\nState:\tZ' not in (proc/'status').read_text(): raise SystemExit('Worker still exists; inspect first')
 w.jobs.retry(row['id'],True,'核查 worker 已退出、未生成 PPTX；修复制作目录绑定后重试一次')
print(encode(Courseware(w.store).run(row['id'])))
PY
