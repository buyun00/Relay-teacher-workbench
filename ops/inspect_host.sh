set -euo pipefail
python3 - <<'PY'
import json, pathlib, subprocess
names = subprocess.check_output(['docker','ps','-a','--format','{{.Names}}'], text=True).splitlines()
for name in names:
    if not any(s in name for s in ('hermes', 'speech', 'classroom')):
        continue
    d = json.loads(subprocess.check_output(['docker','inspect',name], text=True))[0]
    print(json.dumps({'container':name,'image':d['Config']['Image'],'state':d['State']['Status'],
        'mounts':[{k:m.get(k) for k in ('Source','Destination','RW')} for m in d.get('Mounts',[])],
        'ports':d['HostConfig'].get('PortBindings'),'limits':{k:d['HostConfig'].get(k) for k in ('Memory','NanoCpus','DeviceRequests')},
        'network':{k:v.get('IPAddress') for k,v in d['NetworkSettings']['Networks'].items()}},ensure_ascii=False))
for p in ['/AGENTS.md','/srv/AGENTS.md','/srv/ai/AGENTS.md','/srv/ai/hermes-agent/AGENTS.md']:
    f=pathlib.Path(p)
    if f.is_file():
        print('INSTRUCTIONS',p)
        print(f.read_text())
for p in ['/srv/ai/hermes-agent','/srv/ai/hermes-agent/data','/srv/ai/hermes-classroom','/srv/ai/local-speech-api/integration']:
    f=pathlib.Path(p)
    if f.is_dir():
        print('DIR',p, json.dumps([x.name for x in f.iterdir()],ensure_ascii=False))
PY
docker exec hermes-agent sh -c 'id; pwd; command -v hermes; command -v python; ls /opt/data/skills'
docker exec hermes-agent sh -c 'hermes --version; hermes --help'
