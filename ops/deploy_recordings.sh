#!/usr/bin/env bash
# Targeted plugin deployment and one private receiver service. Run as administrator.
set -euo pipefail
: "${HERMES_UPLOADER_TOKEN:?Receiver credential required in environment}"
bundle=/home/lin-server/teacher-workbench-upload/recording-plugin.tar.gz
target=/srv/ai/hermes-agent/data/profiles/teacher-workbench/plugins/teacher-workbench
service=/srv/ai/teacher-recordings
test -f "$bundle"
# Verify the existing native runtime, then create a consistent data backup.
docker exec --user hermes -i -w /opt/data/profiles/teacher-workbench/plugins/teacher-workbench hermes-agent /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path
from workbench.config import Config
from workbench.storage import Store
print('DATA_BACKUP', Store(Config.load(home=Path('/opt/data/profiles/teacher-workbench'))).backup()['backup_id'])
PY
if systemctl is-active --quiet teacher-recordings.service; then systemctl stop teacher-recordings.service; fi
mkdir -p /srv/ai/hermes-agent/data/teacher-plugin-backups "$service"
tar -czf /srv/ai/hermes-agent/data/teacher-plugin-backups/recordings-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C "$target" workbench plugin.yaml
tar -xzf "$bundle" -C "$target" workbench plugin.yaml
docker exec hermes-agent chown -R hermes:hermes /opt/data/profiles/teacher-workbench/plugins/teacher-workbench/workbench
docker exec hermes-agent chown hermes:hermes /opt/data/profiles/teacher-workbench/plugins/teacher-workbench/plugin.yaml
install -m 644 /home/lin-server/teacher-workbench-upload/recording_bridge.py "$service/recording_bridge.py"
umask 077
printf 'HERMES_UPLOADER_TOKEN=%s\n' "$HERMES_UPLOADER_TOKEN" > "$service/receiver.env"
cat > /etc/systemd/system/teacher-recordings.service <<'UNIT'
[Unit]
Description=Teacher recording receiver and native Hermes workflow
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=simple
EnvironmentFile=/srv/ai/teacher-recordings/receiver.env
ExecStart=/usr/bin/python3 /srv/ai/teacher-recordings/recording_bridge.py --host 10.100.0.169 --port 8767
Restart=on-failure
RestartSec=10
TimeoutStopSec=55
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now teacher-recordings.service
systemctl is-active teacher-recordings.service
