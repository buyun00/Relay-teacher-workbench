# 桌面对话

React 负责会话列表、流式 Markdown/数学公式、模型选择和步骤显示。Electron 主进程经既有受保护的 LAN 接收端访问对话接口，连接凭据只使用 Windows DPAPI；渲染器不接触服务端模型凭据。浏览器预览展示虚构数据，不执行模型或教学任务。

## 会话与执行

`desktop_chats` 保存桌面 ID 到原生 Hermes 根会话/当前续接会话的映射、固定模型和分类原因。`desktop_turns` 保存消息身份、执行状态和可重连的显示结果；`desktop_chat_events` 保存带单调游标的流式事件。它们位于现有教师 Store，所有运行数据留在仓库之外。

每轮通过原生 `AIAgent.run_conversation` 执行；以同一个 Hermes SessionDB 会话恢复完整的用户、助手和工具历史。模型切换使用原生 SessionDB 的路由更新 API。Hermes 自己压缩上下文时，保留同一个逻辑根并续接其原生后继会话。不会拼接提示词来假装记忆，也不为每条消息创建独立对话。每个会话使用教师 profile 工作目录下的 `chats/<chat_id>` 制作文件。

迁移或备份整段对话时，也要保存原生 profile 的 SessionDB 与会话文件；Store 的业务备份不替代原生历史。若映射仍在但原生历史缺失，续聊会明确失败，防止以空白上下文冒充已恢复的对话。

服务器持久化入队之后执行，每个对话同时只有一轮，接收端最多运行两轮独立对话。请求重试使用相同消息 ID，冲突的内容或重复并行轮次由确定性事务拒绝。流式连接断开仅脱离显示；重新连接从已保存游标续读。客户端退出后任务可继续；明确停止调用 native interrupt，并保存已产生的内容。服务重启保留结果、将中断轮次标记为中断，不自动重做可能已经执行的工具。

步骤来自 native tool_start/tool_complete 回调，显示工具实际返回值；思考状态来自运行时事件。聊天回复结束不代表教学业务任务完成，仍由有效来源、持久化报告与 `teacher_job` 决定完成状态。

## DS 预分类与固定模型

默认 triage 模型为 `deepseek-flash`。根据前几轮真实用户内容与已保存回复，DS 返回结构化需求类别、候选模型、置信度和澄清问题。代码校验候选 ID 和结果类型；第 2 轮已明确且置信度至少 0.75 时固定，最迟第 3 轮采用有效分类。分类失败时显示提示，保持 DS 沟通并下一轮重试，不伪造分类成功。固定后不会因任务措辞变化而自动换模型；手动切换或重新选择自动会留下持久化路由事件。回复期间不能竞争切换。

当前默认选项：DeepSeek Flash（沟通/整理）、DeepSeek V4 Pro（教学文字/写作）、GPT-6 Sol（功能/代码/通用制作）、GPT-6 Astra（严谨数学/复杂备课）。生产 profile 的 `teacher-workbench.json` 可覆盖 `chat_triage_model` 与 `chat_models`；每个模型定义 `id`、`label`、`provider`、`purpose`。DeepSeek 从仓库外的既有 `.env` 读取 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`；Codex 使用已有原生登录配置，不另存浏览器凭据。不得将这些配置或凭据提交到代码仓库。

## HTTP

沿用录音接收端的 Bearer 凭据与空间配置：

- `GET /v1/chat-models`：可选模型。
- `GET/POST /v1/chats`：持久化会话列表/幂等建立映射。
- `GET /v1/chats/<id>`：一致性历史快照和事件游标。
- `POST /v1/chats/<id>/turns`：以客户端生成的固定消息 ID 入队。
- `POST /v1/chats/<id>/model`：空闲时明确切换模型或恢复自动。
- `POST /v1/chats/<id>/cancel`：停止当前轮次。
- `GET /v1/chats/<id>/events?after=<seq>`：可重放 SSE；带保活，连接到期自动续接。

现有 `--auto-process` 接收端启动对话 worker；只部署插件代码并重启它自己，保留 ASR、Hermes 宿主与其他服务。GitHub Actions 仍测试、构建和发布官方更新；每次桌面交付另用 `npm run pack:local` 生成关闭 GitHub 更新的本机安装包。

## 验证层

`tests/test_chats.py` 使用虚构数据验证身份/幂等、互斥、模型固定、停止、恢复与游标一致性。`uploader/tests/chat.test.cjs` 验证增量重放去重和响应丢失后的同 ID 重试；浏览器用虚构回复验证发送、步骤、分类、停止及原上传页面。真实模型、原生教师工具、Electron/安装包连接与恢复另做运行验收，不能以预览或模拟测试代替。
