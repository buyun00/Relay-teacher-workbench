#!/usr/bin/env bash
# Project-only plugin update through native Hermes reload; no service restart.
# The candidate directory contains install_task_routing.py and live-router/.
set -euo pipefail
: "${TASK_ROUTING_CANDIDATE:?Set the uploaded candidate directory inside hermes-agent}"

docker inspect hermes-agent local-speech-api local-qwen3-tts --format '{{.Name}} {{.State.StartedAt}}'
docker exec -i --user hermes -e TASK_ROUTING_CANDIDATE -e HERMES_HOME=/opt/data hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import importlib.util, json, os
from gateway.control_socket import query_gateway_control
status = query_gateway_control(Path('/opt/data'), 'status', timeout=5)
if not status or status.get('active_agents') != 0:
    raise RuntimeError('现有 Hermes 轮次尚未结束，等待后再接入；未修改线上代码')
root = Path(os.environ['TASK_ROUTING_CANDIDATE'])
spec = importlib.util.spec_from_file_location('task_routing_installer', root / 'install_task_routing.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
installer.prepare(Path('/opt/data/plugins/smart-chat-router'), root / 'live-router')
for p in Path('/opt/data/native-classroom').glob('native_*/state.json'):
    if json.loads(p.read_text()).get('state') in {'active', 'delivering'}:
        raise RuntimeError('原有制作或发送尚未结束，未修改线上代码')
print('PREFLIGHT compatible, idle')
PY

if [ "${APPLY_TASK_ROUTING:-0}" != 1 ]; then
    echo 'READ_ONLY: set APPLY_TASK_ROUTING=1 to install this reviewed candidate'
    exit 0
fi

backup=$(docker exec -i -e TASK_ROUTING_CANDIDATE -e HERMES_HOME=/opt/data hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import importlib.util, os
root = Path(os.environ['TASK_ROUTING_CANDIDATE'])
spec = importlib.util.spec_from_file_location('task_routing_installer', root / 'install_task_routing.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
print(installer.install(Path('/opt/data/plugins/smart-chat-router'), root / 'live-router'))
PY
)
finish() {
    result=$?
    trap - EXIT
    if [ "$result" != 0 ]; then
        docker exec -i -e TASK_ROUTING_BACKUP="$backup" -e HERMES_HOME=/opt/data hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
import os, shutil
backup = Path(os.environ['TASK_ROUTING_BACKUP'])
root = Path('/opt/data/plugins/smart-chat-router')
for name in ('__init__.py', 'gateway_tasks.py', 'gateway_task_runner.py'):
    original = backup / name
    if original.is_file():
        shutil.copy2(original, root / name)
    else:
        (root / name).unlink(missing_ok=True)
PY
        docker exec -i --user hermes -e HERMES_HOME=/opt/data hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
from gateway.control_socket import reload_gateway_plugins
result = reload_gateway_plugins(Path('/opt/data'), timeout=25)
print('ROLLBACK_RELOAD', bool(result and result.get('reloaded')))
PY
        echo "FAILED: source restored; business state retained; backup $backup"
    fi
    exit "$result"
}
trap finish EXIT

docker exec --user hermes -e HERMES_HOME=/opt/data -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench hermes-agent /opt/hermes/.venv/bin/python -m workbench.hermes_entry plugins doctor smart-chat-router --ci
docker exec -i --user hermes -e HERMES_HOME=/opt/data hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
from gateway.control_socket import reload_gateway_plugins
result = reload_gateway_plugins(Path('/opt/data'), timeout=25)
activation = next((p for p in (result or {}).get('activations', []) if p.get('key') == 'smart-chat-router'), None)
if not result or not result.get('reloaded') or not activation:
    raise RuntimeError('原生插件热加载未确认')
if 'pre_gateway_dispatch' not in activation.get('activated_now', {}).get('gateway_transforms', []):
    raise RuntimeError('钉钉入口钩子未确认')
print('NATIVE_HOT_RELOAD', {'reloaded': result['reloaded'], 'adapters_rewired': result.get('adapters_rewired'), 'router': activation})
root = Path('/opt/data/plugins/smart-chat-router')
assert 'isolated DingTalk task routing' in (root / '__init__.py').read_text()
assert 'material_batches' in (root / 'gateway_tasks.py').read_text()
print('LIVE_TASK_ROUTING installed; continuous uploads wait for prompt')
PY
docker inspect hermes-agent local-speech-api local-qwen3-tts --format '{{.Name}} {{.State.StartedAt}}'
printf 'PLUGIN_BACKUP %s\n' "$backup"
trap - EXIT
