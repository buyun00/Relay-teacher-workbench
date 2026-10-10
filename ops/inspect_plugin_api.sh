set -euo pipefail
python3 - <<'PY'
import subprocess, pathlib
body=r'''
from pathlib import Path
import inspect, json
from hermes_cli.plugins import PluginContext
for n in ['register_tool','register_hook','register_skill','register_system_prompt_section']:
 f=getattr(PluginContext,n,None)
 if f: print('API',n,inspect.getsource(f))
for p in ['/opt/hermes/hermes_cli/profiles.py','/opt/hermes/hermes_cli/plugins_manifest.py','/opt/data/plugins/smart-chat-router/plugin.yaml','/opt/data/skills/classroom-ppt-coach/SKILL.md','/opt/data/skills/local-speech-api/scripts/speech_client.py']:
 f=Path(p)
 if not f.is_file(): continue
 s=f.read_text()
 if p.endswith('profiles.py'):
  lines=s.splitlines()
  for a,b in [(1010,1080),(1180,1238),(1270,1320)]:
   print('SOURCE',p,a,b)
   print('\n'.join(lines[a-1:b]))
 elif p.endswith('plugins_manifest.py'):
  lines=s.splitlines()
  for a,b in [(75,145),(285,330)]:
   print('SOURCE',p,a,b)
   print('\n'.join(lines[a-1:b]))
 else:
  print('SOURCE',p)
  print(s[:18000])
'''
r=subprocess.run(['docker','exec','-i','hermes-agent','/opt/hermes/.venv/bin/python','-'],input=body,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
print(r.stdout)
raise SystemExit(r.returncode)
PY
python3 - <<'PY'
from pathlib import Path
import json, subprocess
print('ASR_FILES', [p.name for p in Path('/srv/ai/local-speech-api').iterdir() if p.is_file()])
print('ASR_COMPOSE', Path('/srv/ai/local-speech-api/compose.yaml').read_text())
print('ASR_STATE',subprocess.check_output(['docker','inspect','local-speech-api','--format','{{json .State}}'],text=True))
print('GPU',subprocess.check_output(['nvidia-smi','--query-gpu=uuid,memory.total,memory.used','--format=csv,noheader'],text=True))
print('ASR_HEALTH_ENDPOINTS', Path('/srv/ai/local-speech-api/app.py').read_text()[:9000])
PY
