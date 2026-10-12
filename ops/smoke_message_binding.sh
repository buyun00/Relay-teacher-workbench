set -euo pipefail
docker exec --user hermes -i -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
import os,subprocess
prompt='请实际调用 teacher_context overview。仅返回 current_message_id 字段值。如果该字段为空则说明本轮教师消息没有绑定，不要编造。'
r=subprocess.run(['/opt/hermes/.venv/bin/python','-m','workbench.hermes_entry','-z',prompt],env=dict(os.environ,HERMES_HOME='/opt/data/profiles/teacher-workbench-demo'),capture_output=True,text=True)
print(r.stdout);print(r.stderr)
if r.returncode or 'msg_' not in r.stdout:raise SystemExit('Message binding smoke test failed')
PY
