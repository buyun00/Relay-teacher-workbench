set -euo pipefail
docker exec -i -e HERMES_HOME=/opt/data/profiles/teacher-workbench-demo hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import json,yaml
from hermes_constants import get_hermes_home
from hermes_cli.plugins import discover_plugins,get_plugin_toolsets
discover_plugins()
from tools.registry import registry
from toolsets import resolve_toolset
print('HOME',get_hermes_home())
print('SETS', [x[0] for x in get_plugin_toolsets()])
print('RESOLVED',resolve_toolset('teacher_workbench'))
print('DEFS',[d.get('function',d).get('name') for d in registry.get_definitions(set(resolve_toolset('teacher_workbench')),quiet=True)])
count=0
for directory in ['cli','hermes_cli','agent']:
 for p in (Path('/opt/hermes')/directory).rglob('*.py'):
  lines=p.read_text().splitlines()
  for i,l in enumerate(lines):
   if 'platform_toolsets' in l and 'test' not in str(p) and count<12:
    print('SOURCE',str(p),i+1,'\n'+'\n'.join(lines[max(0,i-3):i+15]));count+=1
PY
docker exec hermes-agent /opt/hermes/bin/hermes -p teacher-workbench-demo tools --summary
