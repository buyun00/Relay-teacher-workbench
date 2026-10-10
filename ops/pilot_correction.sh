set -euo pipefail
docker exec -i -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import os,subprocess
prompt='''这是另一个新会话的教师更正验收，请实际保存，不要只承诺。
我确认 demo_event 的回答者是 demo_s02（虚构学生乙），并确认：他当时知道根号下可以等于零，只是书写时遗漏了端点，不应判断成概念不理解。
读取事件当前版本和对应待确认问题后，保存身份与内容更正。查询该学生在两课中的记录，检查旧 brief 和 preparation 已过期。
重新保存一份完整15分钟、4页的定义域端点与单调性衔接 preparation，附现有课堂、当前更正和成绩真实引用；注意教师解释是观察，不伪称录音证明原因。
再用 teacher_courseware prepare/run 把这份有效备课提交给已有课件能力。要求4页16:9、原生手动点击动画、过渡、逐页教师备注，白底清晰，公式可编辑。返回持久化 job_id 后可结束，课件后台状态不能误报为已完成。
另外请复盘 ready 的 demo_audio 真实ASR测试录音：读取带时间片段，保存简报，claim/complete对应audio业务任务。全部资料是虚构验收数据。'''
log=Path('/opt/data/teacher-workspaces/fictional-demo/pilot-correction.log')
with log.open('w') as out:
 r=subprocess.run(['/opt/hermes/.venv/bin/python','-m','workbench.hermes_entry','-z',prompt],
  cwd='/opt/data/profiles/teacher-workbench/plugins/teacher-workbench',env=dict(os.environ,HERMES_HOME='/opt/data/profiles/teacher-workbench-demo'),stdout=out,stderr=subprocess.STDOUT)
print('CORRECTION_EXIT',r.returncode)
print(log.read_text()[-6000:])
raise SystemExit(r.returncode)
PY
