set -euo pipefail
docker exec -i hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import os,stat,json
for value in ['/opt/data','/opt/data/teacher-workspaces','/opt/data/teacher-workspaces/fictional-demo','/opt/data/teacher-workspaces/fictional-demo/drafts','/opt/data/profiles/teacher-courseware','/opt/data/profiles/teacher-courseware/skills','/opt/data/profiles/teacher-courseware/skills/courseware/pptx','/opt/data/lazy-packages']:
 p=Path(value)
 if p.exists():s=p.stat();print(value,oct(stat.S_IMODE(s.st_mode)),s.st_uid,s.st_gid)
for p in Path('/opt/hermes/tools').glob('*local*'):
 print('LOCAL_BACKEND',str(p))
PY
