set -euo pipefail
docker exec --user hermes -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench hermes-agent /opt/hermes/.venv/bin/python -m unittest discover -s tests -v
docker exec --user hermes -i hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import subprocess
prompt='''这是虚构教学材料的验收，全部操作只用教师工具。文件都在 /opt/data/teacher-workspaces/fictional-demo/inbox。
请实际导入 roster.csv 为 demo_class（虚构班级），建立 demo_l1（2026-10-01，定义域）、demo_l2（2026-10-02，单调性），导入 lesson1.json 和 lesson2.json。
导入 scores.csv 为 demo_exam，q1、q2 均满分10，q2知识点为定义域（教师确认 confirmed），q1知识点未知。
依据第一课中遗漏根号端点的实际片段，记录事件 demo_event，学生身份未知，提出一条身份确认问题。
用统计工具统计成绩，用查询工具跨两课查定义域，读出连续片段后保存约200字简报（brief），以及一份用于4页PPT的备课（preparation）。备课要有定义域端点练习、答案、15分钟流程和学生情况依据。
保存产物必须附工具返回的真实当前版本来源。完成实际保存，不要只给计划。最后给我 artifact_id 与 event_id。不要制作PPT，本轮只到备课。'''
log=Path('/opt/data/teacher-workspaces/fictional-demo/pilot-native.log')
with log.open('w') as out:
 import os
 env=dict(os.environ,HERMES_HOME='/opt/data/profiles/teacher-workbench-demo')
 r=subprocess.run(['/opt/hermes/.venv/bin/python','-m','workbench.hermes_entry','-z',prompt],cwd='/opt/data/profiles/teacher-workbench/plugins/teacher-workbench',env=env,stdout=out,stderr=subprocess.STDOUT)
print('NATIVE_EXIT',r.returncode,'LOG',str(log))
print(log.read_text()[-7000:])
raise SystemExit(r.returncode)
PY
