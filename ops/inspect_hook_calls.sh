set -euo pipefail
docker exec -i hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
for p in [Path('/opt/hermes/run_agent.py'), *Path('/opt/hermes/agent').rglob('*.py')]:
 lines=p.read_text().splitlines()
 for i,l in enumerate(lines):
  if any(x in l for x in ['"pre_llm_call"', "'pre_llm_call'", '"post_tool_call"', '"on_session_end"']):
   print('SOURCE',str(p),i+1)
   print('\n'.join(lines[max(0,i-4):i+20]))
PY
docker exec hermes-agent /opt/hermes/bin/hermes plugins doctor --help
