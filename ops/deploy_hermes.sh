#!/usr/bin/env bash
# Run on the existing host with Docker administration privileges. Never restarts a service.
set -euo pipefail
archive=/home/lin-server/teacher-workbench-upload/plugin.tar.gz
test -f "$archive"
docker exec -i hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import subprocess
for name in ['teacher-workbench','teacher-workbench-demo','teacher-courseware']:
 home=Path('/opt/data/profiles')/name
 if not home.exists():
  subprocess.run(['/opt/hermes/bin/hermes','profile','create',name,'--no-skills','--no-alias'],check=True)
PY
python3 - <<'PY'
from pathlib import Path
import tarfile, time
root=Path('/srv/ai/hermes-agent/data')
plugin=root/'profiles/teacher-workbench/plugins/teacher-workbench'
if plugin.exists():
 backup=root/'teacher-plugin-backups'
 backup.mkdir(exist_ok=True)
 with tarfile.open(backup/(time.strftime('%Y%m%d-%H%M%S')+'.tar.gz'),'w:gz') as a:
  a.add(plugin,arcname='teacher-workbench')
plugin.mkdir(parents=True,exist_ok=True)
with tarfile.open('/home/lin-server/teacher-workbench-upload/plugin.tar.gz','r:gz') as a:
 for member in a.getmembers():
  target=(plugin/member.name).resolve()
  if not target.is_relative_to(plugin.resolve()) or member.issym() or member.islnk():
   raise SystemExit('Invalid bundle entry')
 a.extractall(plugin,filter='data')
demo=root/'profiles/teacher-workbench-demo/plugins/teacher-workbench'
demo.parent.mkdir(parents=True,exist_ok=True)
if not demo.exists():
 demo.symlink_to('../../teacher-workbench/plugins/teacher-workbench',target_is_directory=True)
PY
docker exec -i hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import shutil,json,yaml,os
root=Path('/opt/data')
source=yaml.safe_load((root/'config.yaml').read_text())
model=source.get('model',{})
model={k:v for k,v in model.items() if k in {'default','provider','base_url'}} if isinstance(model,dict) else model
for name,workspace in [('teacher-workbench','teacher'),('teacher-workbench-demo','fictional-demo')]:
 home=root/'profiles'/name
 cfg=yaml.safe_load((home/'config.yaml').read_text()) or {}
 cfg.update({'model':model,'plugins':{'enabled':['teacher-workbench']},
   'platform_toolsets':{'cli':['teacher_workbench','skills']}, 'terminal':{'backend':'local','cwd':str(home/'workspace')},
   'agent':{'max_turns':50},'gateway':{'standalone':True}})
 (home/'config.yaml').write_text(yaml.safe_dump(cfg,allow_unicode=True,sort_keys=False))
 data=root/'teacher-workspaces'/workspace
 (data/'inbox').mkdir(parents=True,exist_ok=True)
 settings={'workspace_id':workspace,'data_root':str(data),'import_roots':[str(data/'inbox')],
   'speech_url':'http://10.100.0.169:8765','speech_client':'/opt/data/skills/local-speech-api/scripts/speech_client.py',
   'hermes_command':'/opt/hermes/bin/hermes','courseware_profile':'teacher-courseware','courseware_uid':10000}
 (home/'teacher-workbench.json').write_text(json.dumps(settings,ensure_ascii=False,indent=2))
 os.chmod(home/'teacher-workbench.json',0o600)
producer=root/'profiles/teacher-courseware'
cfg=yaml.safe_load((producer/'config.yaml').read_text()) or {}
cfg.update({'model':model,'platform_toolsets':{'cli':['terminal','file','skills']},
 'terminal':{'backend':'local','cwd':str(producer/'workspace')},'agent':{'max_turns':80},'gateway':{'standalone':True}})
(producer/'config.yaml').write_text(yaml.safe_dump(cfg,allow_unicode=True,sort_keys=False))
for name in ['classroom-ppt-coach','courseware']:
 src=root/'skills'/name
 if not src.is_dir(): raise SystemExit('Existing courseware skill missing: '+name)
 shutil.copytree(src,producer/'skills'/name,dirs_exist_ok=True)
# Fictional fixtures are imported only into the demo workspace; production remains clean.
fixture=root/'profiles/teacher-workbench/plugins/teacher-workbench/tests/fixtures'
for file in fixture.iterdir():
 shutil.copy2(file,root/'teacher-workspaces/fictional-demo/inbox'/file.name)
print('PROFILES_CONFIGURED', ['teacher-workbench','teacher-workbench-demo','teacher-courseware'])
# A native bootstrap fixes discovery ordering in this installed version's fast -z path.
bin_dir=root/'teacher-bin'
bin_dir.mkdir(exist_ok=True)
launcher=bin_dir/'teacher'
launcher.write_text('''#!/bin/sh
export HERMES_HOME=/opt/data/profiles/teacher-workbench
cd /opt/data/profiles/teacher-workbench/plugins/teacher-workbench || exit 1
exec /opt/hermes/.venv/bin/python -m workbench.hermes_entry "$@"
''')
os.chmod(launcher,0o700)
PY
docker exec hermes-agent /opt/hermes/bin/hermes -p teacher-workbench plugins doctor teacher-workbench --ci
docker exec hermes-agent /opt/hermes/bin/hermes -p teacher-workbench-demo plugins doctor teacher-workbench --ci
