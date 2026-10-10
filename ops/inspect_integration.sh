set -euo pipefail
docker exec hermes-agent hermes profile create --help
docker exec hermes-agent hermes profile list
docker exec hermes-agent hermes plugins list
python3 - <<'PY'
import subprocess
body=r'''
import pathlib, json, yaml, os
c=yaml.safe_load(pathlib.Path('/opt/data/config.yaml').read_text())
safe={k:c.get(k) for k in ['model','terminal','platform_toolsets','skills','agent','plugins']}
def scrub(x):
 if isinstance(x,dict): return {k:('[REDACTED]' if any(s in k.lower() for s in ['secret','token','key','password','credential']) else scrub(v)) for k,v in x.items()}
 if isinstance(x,list): return [scrub(v) for v in x]
 return x
print('CONFIG_SUBSET',json.dumps(scrub(safe),ensure_ascii=False))
for p in ['/opt/hermes/hermes_cli/plugins.py','/opt/hermes/hermes_cli/profiles.py','/opt/hermes/hermes_plugins','/opt/hermes/plugins','/opt/data/plugins']:
 f=pathlib.Path(p)
 if f.is_dir(): print('DIR',p,[x.name for x in f.iterdir()][:40])
ranges={
 '/opt/hermes/hermes_cli/profiles.py':[(1150,1195),(1240,1270),(1328,1355)],
 '/opt/hermes/tools/registry.py':[(662,690)],
 '/opt/hermes/hermes_cli/plugins.py':[(1,65)]}
for p,rs in ranges.items():
 f=pathlib.Path(p)
 if not f.is_file(): continue
 lines=f.read_text().splitlines()
 for a,b in rs:
  print('SOURCE',p,a,b)
  for i in range(a-1,min(b,len(lines))): print(str(i+1),lines[i])
'''
r=subprocess.run(['docker','exec','-i','hermes-agent','/opt/hermes/.venv/bin/python','-'],input=body,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
print(r.stdout)
raise SystemExit(r.returncode)
PY
