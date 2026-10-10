set -euo pipefail
docker exec -i hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
for name in ['run_agent.py','hermes_cli/main.py','hermes_cli/plugins.py','tools/registry.py','hermes_cli/profiles.py']:
 p=Path('/opt/hermes')/name
 lines=p.read_text().splitlines()
 for i,l in enumerate(lines):
  if any(x in l for x in ['invoke_hook("pre_llm_call"','invoke_hook("pre_tool_call"','invoke_hook("post_tool_call"','"pre_llm_call",','"pre_tool_call",','"on_session_end",','toolset in','def handle_profile_create','def invoke_hook','ctx = PluginContext','"provides_tools":']):
   print('SOURCE',name,i+1)
   print('\n'.join(lines[max(0,i-3):i+24]))
PY
docker exec hermes-agent /opt/hermes/bin/hermes profile create --help
docker exec hermes-agent /opt/hermes/bin/hermes plugins --help
