set -euo pipefail
source_dir=/srv/ai/hermes-agent/data/teacher-workspaces/fictional-demo/drafts/job_46b20cb254c14c70
target_dir=/home/lin-server/teacher-workbench-upload/acceptance
test -f "$source_dir/lesson.pptx"
install -m 600 -o lin-server -g lin-server "$source_dir/lesson.pptx" "$target_dir/teacher-pilot.pptx"
for name in overview p01 p02 p03 p04; do
 if test -f "$source_dir/renders/$name.png"; then
  install -m 600 -o lin-server -g lin-server "$source_dir/renders/$name.png" "$target_dir/$name.png"
 fi
done
for name in validation.md structural-report.json package-report.json render-report.json; do
 if test -f "$source_dir/$name"; then
  install -m 600 -o lin-server -g lin-server "$source_dir/$name" "$target_dir/$name"
 fi
done
