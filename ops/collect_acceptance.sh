set -euo pipefail
mkdir -p /home/lin-server/teacher-workbench-upload/acceptance
docker exec --user hermes -i -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import json
from workbench.config import Config
from workbench.service import Workbench
from workbench.storage import atomic_write,encode
w=Workbench(Config.load(home=Path('/opt/data/profiles/teacher-workbench-demo')))
with w.store.connect() as db:
 result={name:[dict(r) for r in db.execute('SELECT '+fields+' FROM '+name)] for name,fields in [
  ('artifacts','id,kind,title,path,sources,stale,validation'),('jobs','id,kind,state,attempts,external_id,result,error'),
  ('corrections','id,target_kind,target_id,before_json,after_json,message_id'),('questions','id,event_id,status') ]}
result.update(event=w.facts.read_event('demo_event'),statistics=w.facts.score_stats('demo_exam'),cross_lesson_query=w.query.search('定义域',class_id='demo_class'))
atomic_write(w.store.root/'acceptance.json',encode(result).encode())
print('EVIDENCE_SAVED')
for a in w.artifacts.list(include_stale=True)['artifacts']:print(a['id'],a['kind'],a['absolute_path'],a['stale'])
PY
cp /srv/ai/hermes-agent/data/teacher-workspaces/fictional-demo/acceptance.json /home/lin-server/teacher-workbench-upload/acceptance/acceptance.json
cp /srv/ai/hermes-agent/data/teacher-workspaces/fictional-demo/artifacts/artifact_49089c3a146e44c4/content.md /home/lin-server/teacher-workbench-upload/acceptance/asr-review.md
cp /srv/ai/hermes-agent/data/teacher-workspaces/fictional-demo/artifacts/artifact_7b770d16c8f54078/content.md /home/lin-server/teacher-workbench-upload/acceptance/preparation.md
cp /srv/ai/hermes-agent/data/teacher-workspaces/fictional-demo/artifacts/artifact_765e6cebd5bb4291/content.md /home/lin-server/teacher-workbench-upload/acceptance/historical-brief.md
chown -R lin-server:lin-server /home/lin-server/teacher-workbench-upload/acceptance
