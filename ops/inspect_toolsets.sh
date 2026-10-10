set -euo pipefail
docker exec -i hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
for name in ['hermes_cli/main.py','run_agent.py','toolsets.py','hermes_cli/plugins.py']:
 p=Path('/opt/hermes')/name
 lines=p.read_text().splitlines()
 for i,l in enumerate(lines):
  if any(x in l for x in ['platform_toolsets','plugin_toolsets','get_plugin_toolsets','def get_toolset','def resolve_toolset','_plugin_tool_names','enabled_toolsets=','enabled_toolsets =','return get_toolset']):
   print('SOURCE',name,i+1)
   print('\n'.join(lines[max(0,i-3):i+22]))
PY
docker exec hermes-agent /opt/hermes/bin/hermes -p teacher-workbench-demo plugins list
docker exec hermes-agent /opt/hermes/bin/hermes -p teacher-workbench-demo tools --help
