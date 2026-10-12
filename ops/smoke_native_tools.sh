set -euo pipefail
docker exec --user hermes -i -e HERMES_HOME=/opt/data/profiles/teacher-workbench-demo hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from tools.tool_search import load_config
assert load_config().enabled == 'off', 'Teacher tools must be directly exposed to the model'
print('TEACHER_DIRECT_TOOLS_CONFIG_OK')
PY
docker exec --user hermes -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench -e HERMES_HOME=/opt/data/profiles/teacher-workbench-demo hermes-agent /opt/hermes/.venv/bin/python -m workbench.hermes_entry -z '请实际调用 teacher_context overview，然后只输出 workspace_id 和 lesson_count。'
