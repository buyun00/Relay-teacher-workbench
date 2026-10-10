set -euo pipefail
docker exec hermes-agent /opt/hermes/bin/hermes --help
docker exec -i hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
for p in Path('/opt/hermes').glob('**/*.py'):
 if any(x in p.parts for x in ['.venv','.git','tests','node_modules']): continue
 if not (p.parts[-2] in ['cli','hermes_cli','agent'] or p.name in ['cli.py','model_tools.py']): continue
 lines=p.read_text().splitlines()
 indices=[i for i,l in enumerate(lines) if ('platform_toolsets' in l and p.name=='cli.py') or 'args.query' in l or 'args.quiet' in l or 'def _get_platform_tools' in l]
 for i in indices[:3]:
  print('SOURCE',str(p),i+1,'\n'+'\n'.join(lines[max(0,i-5):i+28]))
import sqlite3
db=sqlite3.connect('/opt/data/teacher-workspaces/fictional-demo/database/workbench.sqlite')
print('MESSAGES',db.execute('SELECT COUNT(*) FROM messages').fetchone()[0])
print('AUDIT',db.execute('SELECT operation,target_id FROM audit').fetchall()[-12:])
PY
