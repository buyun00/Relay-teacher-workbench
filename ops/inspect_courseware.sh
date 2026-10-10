set -euo pipefail
python3 - <<'PY'
from pathlib import Path
import subprocess
for p in ['/srv/ai/classroom-ppt-bot/courseware_flow.py','/srv/ai/classroom-ppt-bot/native_backend.py','/srv/ai/classroom-ppt-bot/gpt_tiers.py']:
 f=Path(p)
 lines=f.read_text().splitlines()
 print('SOURCE',p)
 for i,s in enumerate(lines):
  if any(k in s for k in ['def ','class ','@app.','Popen','AIAgent','courseware_lib','run_agent','HERMES_HOME']):
   print(i+1,s[:180])
print('SPEECH_HEALTH')
print(subprocess.check_output(['docker','exec','hermes-agent','/opt/hermes/.venv/bin/python','-c',"import urllib.request; print(urllib.request.urlopen('http://10.100.0.169:8765/health',timeout=8).read().decode())"],text=True))
body=r'''
from pathlib import Path
for p in ['/opt/data/courseware-lib','/opt/data/skills/classroom-ppt-coach/scripts','/opt/data/skills/courseware']:
 f=Path(p)
 if f.is_dir(): print('DIR',p,[x.name for x in f.iterdir()])
for p in ['/opt/data/skills/classroom-ppt-coach/references/auxiliary-skills.md','/opt/data/skills/courseware/pptx/SKILL.md']:
 f=Path(p)
 if f.is_file(): print('REFERENCE',p, f.read_text()[:7000])
from hermes_cli.plugins import VALID_HOOKS
print('VALID_HOOKS',sorted(VALID_HOOKS))
'''
r=subprocess.run(['docker','exec','-i','hermes-agent','/opt/hermes/.venv/bin/python','-'],input=body,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
print(r.stdout)
PY
