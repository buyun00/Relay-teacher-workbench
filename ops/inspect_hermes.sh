set -euo pipefail
docker exec hermes-agent sh -c 'hermes profile --help; hermes plugins --help; hermes chat --help; hermes skills --help'
docker exec hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
PY
python3 - <<'PY'
import subprocess
body=r'''
import pathlib, json, yaml, os
print('HERMES_HOME',os.environ.get('HERMES_HOME'))
p=pathlib.Path('/opt/data/config.yaml')
c=yaml.safe_load(p.read_text())
safe={k:c.get(k) for k in ['model','terminal','platform_toolsets','skills','profiles','webhooks','agent']}
def scrub(x):
 if isinstance(x,dict): return {k:('[REDACTED]' if any(s in k.lower() for s in ['secret','token','key','password','credential']) else scrub(v)) for k,v in x.items()}
 if isinstance(x,list): return [scrub(v) for v in x]
 return x
print('CONFIG_SUBSET',json.dumps(scrub(safe),ensure_ascii=False))
for p in ['/opt/data/plugins','/opt/data/native-classroom','/opt/hermes/hermes_cli','/opt/hermes/tools','/opt/hermes/hermes_cli/plugins.py']:
 f=pathlib.Path(p)
 if f.is_dir(): print('DIR',p,[x.name for x in f.iterdir()])
for p in ['/opt/hermes/hermes_cli/plugins.py','/opt/hermes/hermes_cli/profiles.py','/opt/hermes/tools/registry.py']:
 f=pathlib.Path(p)
 if f.is_file():
  lines=f.read_text().splitlines()
  for i,s in enumerate(lines):
   if any(k in s for k in ['def ','manifest','register_tool','HERMES_HOME','skills','auth.json','.env','config.yaml','toolsets','profiles_dir']):
    print(p,str(i+1),s[:200])
'''
r=subprocess.run(['docker','exec','-i','hermes-agent','/opt/hermes/.venv/bin/python','-'],input=body,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
print(r.stdout)
raise SystemExit(r.returncode)
PY
