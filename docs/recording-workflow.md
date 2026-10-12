# 上传后的自动处理

桌面设备读取和手动选文件共用同一流程：本机副本与 SQLite 队列 → 接收端持久化原件与匹配回执 → 既有 ASR → 保存原始转写及带时间片段 → 原生 Hermes 保存 brief、preparation → 校验来源及文件后完成 → 桌面状态和结果。

`recording_workflows` 和既有任务共用教师 SQLite，按原件内容唯一登记。上传回执与工作流入队在同一事务内提交。重新上传、改文件名、丢失回执或服务重启不会创建重复的录音流程。跟进转写只查询已经保存的外部任务 ID；提交结果不明确时显示需要检查，避免重复提交。

已保存转写之后的中断可以继续制作缺失的报告；现有有效报告可以复用。工作流租约和 fence 阻止旧执行者把新流程标成完成。原生 `teacher_artifact` 在保存事务里绑定流程，正文、来源版本及报告 ID 实际保存后才有效；会话退出或聊天回复不能代替完成。教师更正会保留原始转写和历史，并使相关报告、客户端完成状态过期。

录音文件不自动等同于课次。未知班级、日期、学生身份保留未知，不跨录音合并匿名 speaker。后台报告给出基于转写的课堂复盘和15分钟补充练习，教学判断仍由教师审阅。此流程不自动生成 PPT；对话页面按之前约定仍只保存本机草稿。

## 当前 H3 部署

- 教师 profile：`/opt/data/profiles/teacher-workbench`。
- 资料：`/opt/data/teacher-workspaces/teacher`，在仓库外。
- 接收地址：`http://10.100.0.169:8767`，空间 ID `teacher`。
- 语音服务：沿用教师配置的 `speech_url`，当前是 `http://10.100.0.169:8765`。8766 是既有语音合成服务。
- 后台：宿主 `teacher-recordings.service`，只管理新增录音接收端，不重启 Hermes 容器或其他服务。

现有 Hermes 容器没有发布录音端口。`ops/recording_bridge.py` 通过宿主 Docker CLI 在现有容器内以 hermes 用户启动接收/工作线程，并把指定内网地址转发到容器；不挂载 Docker socket，不修改 Hermes 核心。停止时核对记录的 PID 对应 `workbench.ingress` 后，仅停止自己的接收进程。

`ops/deploy_recordings.sh` 是该宿主的定向更新脚本：先用 Store.backup 保存一致性备份及旧插件包，再更新插件业务目录和自己的桥服务。归档上传到 `/home/lin-server/teacher-workbench-upload/recording-plugin.tar.gz`，仅含 workbench 源码；同时上传 `recording_bridge.py`。部署需要管理员 SSH/sudo，并通过环境传入接收凭据。

凭据保存在宿主 `/srv/ai/teacher-recordings/receiver.env`（root，0600）和本机 Windows 凭据管理器；客户端通过 safeStorage/DPAPI 保存连接凭据。不会写入源码、测试证据、安装包或 GitHub。普通 GitHub push 自动更新 Windows 安装包；服务器业务变更需执行上述定向部署，不把管理员 SSH 或服务器凭据交给 GitHub Actions。

## 状态与恢复

`POST /v1/status` 返回 queued、transcribing、analyzing、analyzed、needs_attention 或 stale。`workflow.complete` 只有当前 brief 和 preparation 均保存、来源有效时为真。结果接口只读当前报告，读取或刷新状态不调用 ASR/模型。桌面暂停的是新文件传输，服务器已接收录音仍继续处理。

上传前后断网使用既有分段续传；服务重启从 SQLite 恢复。ASR 的 running/waiting_gpu 跟进同一任务，不当作失败。needs_attention 保留原件、转写及已保存报告，管理员先读工作流 error 和 `drafts/<workflow-id>/hermes.log` 核对原因；不盲目清空外部任务 ID 或重传长音频。

完成后仍保留原始音频、原始 ASR JSON、转写片段、报告与来源版本。数据备份、删除和恢复遵循既有教师资料操作流程。实际设备循环覆盖、USB 接入时是否还能录音、数学转写和教学质量需在现场另行验收。
