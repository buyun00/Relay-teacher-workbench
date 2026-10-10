set -euo pipefail
docker exec -i hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
for name in ['tools/terminal_tool.py','tools/file_tools.py','hermes_cli/main.py','hermes_cli/oneshot.py']:
 p=Path('/opt/hermes')/name
 if not p.exists():continue
 lines=p.read_text().splitlines()
 for i,l in enumerate(lines):
  if 'TERMINAL_CWD' in l or 'terminal_cwd' in l or ('get_cwd' in l and p.name=='file_tools.py'):
   print('SOURCE',name,i+1,'\n'+'\n'.join(lines[max(0,i-3):i+12]))
PY
