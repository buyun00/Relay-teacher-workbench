set -euo pipefail
python3 - <<'PY'
from pathlib import Path
import subprocess, time
p=Path('/srv/ai/local-speech-api/compose.yaml')
text=p.read_text()
gpu=subprocess.check_output(['nvidia-smi','--query-gpu=uuid','--format=csv,noheader'],text=True).splitlines()
if len(gpu)!=1: raise SystemExit('Expected exactly one live GPU; configuration unchanged')
address=subprocess.check_output(['hostname','-I'],text=True).split()
if '10.100.0.169' not in address: raise SystemExit('Expected private host address absent; configuration unchanged')
old_gpu='GPU-424c3226-f909-e75e-0fb6-e463f424c481'
new=text.replace('10.100.5.110:8765','10.100.0.169:8765').replace(old_gpu,gpu[0])
if text!=new:
 backup=p.with_name('compose.before-teacher-'+time.strftime('%Y%m%d-%H%M%S')+'.yaml')
 backup.write_text(text)
 p.write_text(new)
 print('ASR_BINDING_BACKUP',str(backup))
print('ASR_PRIVATE_ADDRESS','10.100.0.169:8765')
PY
cd /srv/ai/local-speech-api
docker compose up -d --no-build
docker inspect local-speech-api --format '{{.State.Status}}'
