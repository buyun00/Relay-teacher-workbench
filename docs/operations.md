# 运行与维护

已部署到现有 `hermes-agent` 容器，未升级 Hermes、未重启默认开发助手。正式教师 profile 为 `teacher-workbench`，虚构验收 profile 为 `teacher-workbench-demo`；两者的数据空间不同。`teacher-courseware` 是复用已有 Skill 的制作环境。

宿主机正式数据目录：`/srv/ai/hermes-agent/data/teacher-workspaces/teacher`。
容器内正式数据目录：`/opt/data/teacher-workspaces/teacher`。
容器内插件目录：`/opt/data/profiles/teacher-workbench/plugins/teacher-workbench`。

在宿主机有 Docker 管理权限的终端进入教师入口：

```sh
sudo docker exec --user hermes -it hermes-agent /opt/data/teacher-bin/teacher
```

单次调用可使用 `/opt/data/teacher-bin/teacher -z '教师问题'`。正式数据空间未导入测试学生。现有网页和消息平台暂未绑定此 profile。

教师 profile 设置 `tools.tool_search.enabled: off`，让 9 个教学工具直接出现在模型工具列表中，同时启用终端、文件和技能工具。插件已移除 `pre_tool_call` 权限拦截，宿主的工具发现入口也可正常使用。教师入口、后台课件和维护命令均使用现有 `hermes` 用户，避免混用 root 创建文件后出现写入失败；没有额外的插件鉴权或目录权限层。

代码更新：本仓库 `py scripts/build_bundle.py` 打包，复制 code-only 包到宿主机 `/home/lin-server/teacher-workbench-upload/plugin.tar.gz` 后，以管理员运行 `ops/deploy_hermes.sh`。脚本在更新前备份旧插件，仅写三个本项目 profile，不修改默认助手，不复制 OAuth 文件，不启动新的公网服务。模型认证使用现有 Hermes 凭据解析机制。配置中的 ASR 地址需要与现场一致。

本次发现现有 ASR 的旧内网 IP 和旧 GPU UUID 已失效，已备份 Compose 后只修复绑定、以既有镜像启动服务。模型及参数未更换。教师配置当前使用开发机已验证的 LAN ASR 地址；以后地址变化应更新 profile 的 teacher-workbench.json。

管理员 CLI 在插件目录执行，指定 profile 配置：

```sh
cd /opt/data/profiles/teacher-workbench/plugins/teacher-workbench
/opt/hermes/.venv/bin/python -m workbench.cli --home /opt/data/profiles/teacher-workbench status
/opt/hermes/.venv/bin/python -m workbench.cli --home /opt/data/profiles/teacher-workbench backup
/opt/hermes/.venv/bin/python -m workbench.cli --home /opt/data/profiles/teacher-workbench export
```

backup 包含一致性 SQLite 快照、原件、转写、产物和非凭据配置。export 增加可读 records.json。数据与备份不能放进 Git。需要另存异机备份时，由管理员复制备份目录；当前没有自动异机备份任务。

恢复必须写入新目录，不覆盖在线库：

```sh
/opt/hermes/.venv/bin/python -m workbench.cli restore /path/to/backup /path/to/new-workspace
```

恢复只检查 SQLite 完整性和版本，保留更正和待确认问题；正在运行或等待外部的任务改为 needs_attention，防止把旧外部执行当作在线任务。将恢复出的 teacher-workbench.config.json 写入相应 profile，确认新 data_root 后使用新空间。旧配置中的 import_roots、courseware_uid、max_file_bytes 已取消。

任务状态：queued 尚未领取；waiting_external 表示已有 ASR 任务 ID；ready 表示转写已保存、待复盘；running 表示持有租约；completed 表示对应产物已保存并通过当前来源检查。needs_attention 要先核对外部执行与文件，不能把任务队列清空后重跑。

课件后台日志位于 `drafts/<job_id>/worker.log` 和 `hermes.log`。管理员确认执行已停止、没有可恢复结果后，才可对非录音任务执行有限重试：

```sh
python -m workbench.cli --home /opt/data/profiles/teacher-workbench retry-job JOB_ID --external-checked --reason '实际核查结果'
```

ASR 不接受这个通用重试入口；保留并核对外部任务 ID。不要因为 waiting_gpu 或网络短时故障重复提交长录音。

删除前先停止涉及这些资料的教师会话，明确课次/测验 ID 并预览：

```sh
python -m workbench.cli --home /opt/data/profiles/teacher-workbench delete-scope --lesson LESSON_ID --exam EXAM_ID
```

预览返回文件、产物、任务及全部已知本地备份的删除范围与 confirmation。执行相同命令并传入 `--confirmation` 返回的完整值；范围变化时必须重新预览。共享原件保留。执行中的任务会阻止删除。异常后执行 `purge` 继续已登记的物理清理；完成后清理 SQLite WAL 并 VACUUM。

范围删除不按文本猜测并删除聊天消息。Hermes 历史、教学库保存的教师消息、ASR 服务自己的任务数据、模型供应商副本及手工复制/下载的文件需要管理员另行处理；不能把本地范围删除声称为所有副本已删除。插件备份目录以外的备份也需要另外核对。

主机离线时不能处理新任务，既有文件和已持久化记录仍保留。ASR 不健康时工具返回失败；文件不误报处理完成。更正学生身份不重新运行 ASR。当前未进行电源断电或真实长课堂压力测试。
