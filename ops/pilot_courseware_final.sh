set -euo pipefail
docker exec -i -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import os,subprocess,sys
from workbench.config import Config
from workbench.service import Workbench
from workbench.courseware import Courseware
from workbench.storage import encode
w=Workbench(Config.load(home=Path('/opt/data/profiles/teacher-workbench-demo')))
c=Courseware(w.store)
j=c.prepare('artifact_7b770d16c8f54078','4页16:9白底课堂PPT，公式可编辑，正文字号至少28，原生点击分步揭示答案，逐页过渡及教师备注。')['job']
folder=w.store.root/'drafts'/j['id']
c.share_brief(folder)
def terminal_user():
 os.setgid(10000);os.setuid(10000)
code='''from pathlib import Path
import sys
brief,db=map(Path,sys.argv[1:])
assert brief.read_text(encoding="utf-8")
test=brief.parent/"permission-test.txt"
test.write_text("test");test.unlink()
try: db.read_bytes()
except PermissionError: print("BRIEF_READ_OK DRAFT_WRITE_OK DATABASE_DENIED")
else: raise RuntimeError("Database exposed to courseware execution user")
'''
subprocess.run([sys.executable,'-c',code,str(folder/'brief.md'),str(w.store.db_path)],preexec_fn=terminal_user,check=True)
print(encode(c.run(j['id'])))
PY
