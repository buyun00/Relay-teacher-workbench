set -euo pipefail
# Only our new demo workspace; expose directory traversal, not database contents.
chmod 711 /srv/ai/hermes-agent/data/teacher-workspaces/fictional-demo /srv/ai/hermes-agent/data/teacher-workspaces/fictional-demo/drafts
chmod 700 /srv/ai/hermes-agent/data/teacher-workspaces/fictional-demo/database /srv/ai/hermes-agent/data/teacher-workspaces/fictional-demo/originals /srv/ai/hermes-agent/data/teacher-workspaces/fictional-demo/transcripts /srv/ai/hermes-agent/data/teacher-workspaces/fictional-demo/artifacts
