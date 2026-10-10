set -euo pipefail
docker exec -i hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
p=Path('/opt/hermes/hermes_cli/oneshot.py')
print('\n'.join(p.read_text().splitlines()[510:588]))
PY
docker exec -e HERMES_HOME=/opt/data/profiles/teacher-workbench-demo hermes-agent /opt/hermes/bin/hermes -t teacher_workbench,skills -z '请实际调用 teacher_context overview，然后只输出 workspace_id 和 lesson_count。'
