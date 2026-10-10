set -euo pipefail
docker exec -i hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import sqlite3
for p in [Path('/opt/hermes/hermes_cli/main.py'),Path('/opt/hermes/hermes_cli/oneshot.py'),Path('/opt/hermes/cli.py')]:
 if not p.exists(): continue
 lines=p.read_text().splitlines()
 for i,l in enumerate(lines):
  if ('oneshot' in l and ('def ' in l or 'if ' in l or 'from ' in l)) or 'enabled_toolsets=' in l:
   print('SOURCE',str(p),i+1,'\n'+'\n'.join(lines[max(0,i-2):i+32]))
for name in ['teacher','fictional-demo']:
 p=Path('/opt/data/teacher-workspaces')/name/'database/workbench.sqlite'
 if p.exists():
  d=sqlite3.connect(p);print('SPACE',name,'MESSAGES',d.execute('SELECT COUNT(*) FROM messages').fetchone()[0]);d.close()
PY
