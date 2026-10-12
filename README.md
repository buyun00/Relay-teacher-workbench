# Hremes 教师工作台

首版把教学资料功能集中到一个原生 Hermes 插件：SQLite 保存事实、关系、人工更正、问题与任务；原始录音、转写和产物保存为文件。已有 ASR 和课件 Skill 继续负责转写与 PPT 制作。

教师插件与数据库继续承担教学事实和处理结果。新一轮增加了 [课堂连接客户端](uploader/README.md)：React 浏览器预览与 Electron 桌面版共用界面，左侧任务列表、右侧对话区，另设简洁的录音上传页。设备文件和手动多选文件共用本地副本、去重与可靠上传；任务草稿先保存在本机，对话服务留到下一步接入。阿里云和学校平台仍不在本次范围。原始架构文档保留在 `teacher_workbench_architecture_v1.md`；其中独立资料后台的部署建议，在插件实施中收拢到了插件内。

## 已实现

- 名单、课次、音频、带时间转写、成绩 CSV 和资料原件导入；按内容去重，文件名改变不重复登记。
- 依据片段记录课堂事件，分开原文事实、推测和教师观察；匿名说话人不自动对应学生。
- 带来源版本的复盘、备课与练习保存；ASR 完成、模型回复和报告实际保存是不同状态。
- 人工更正保存前后值及教师消息，原文件保持原样，相关旧报告失效。
- 按班级、学生、日期跨课次查询，支持中文短词与检索别名，返回真实覆盖范围；可查询当前个人题分。
- 确定性成绩统计，区分零分、空白、缺考、未批改，保留表格单元格来源。
- 调用已有 `local-speech-api` 客户端，以及 Hermes 内部 `classroom-ppt-coach` / `courseware` 技能；课件在独立制作会话内生成。
- 任务持久化、租约、执行者 fencing、重复任务合并、超时恢复、有限尝试和外部提交不明确时停止自动重试。
- 资料导出、一致性备份、恢复到新目录，以及供管理员预览并确认的课次/测验范围删除。

## 使用入口

已安装的开发机上，在容器内执行：

```sh
/opt/data/teacher-bin/teacher
```

该入口使用 `teacher-workbench` 独立 profile。教师资料不使用默认开发会话的记忆或数据库。当前 host 的快速 `hermes -z` 路径在工具快照前可能没有发现插件，因此入口先调用官方 `discover_plugins()`，再进入 Hermes；没有修改 Hermes 核心。

教师 profile 设置 `tools.tool_search.enabled: off`，直接暴露 9 个教学工具，同时可使用 Hermes 的终端、文件和技能工具。插件不拦截工具调用，不限制导入目录、文件大小，也不复核已保存文件哈希或校验课件结构；保留来源版本检查、更正历史、统计规则和实际保存后完成任务的条件。

首轮可将文件放到教师 inbox，然后在这个入口说明：

> 导入 inbox 中的名单和第一节课录音。班级是……，课题是……，上课日期是……。转写后给我一份短复盘，不能确定的身份先保留未知。

> 刚才待确认问题里的学生是……；那次不是没理解，而是书写时遗漏。请保存更正，再查他最近两次课的记录。

> 结合最近两课和这次测验，给我明天的15分钟补充练习，附答案和依据。

长录音提交返回持久化任务 ID；可在后续会话继续查看、复盘同一任务。此版没有目录监听器或无人值守的后台复盘调度：导入与跟进由教师会话发起。PPT 制作提交后在后台运行，查询任务状态即可，不需要聊天会话一直保持连接。

桌面客户端可以自动复制并上传录音；可选接收入口 `python -m workbench.ingress` 复用同一教师 Store。已接收但未关联课次的音频会出现在 `teacher_context overview` 和原生会话上下文的 `pending_recordings` 中。录音的课次归属、ASR 和复盘仍由 Hermes 教学工具处理，接收回执不会触发或冒充教学分析完成。客户端与接收入口的开发、发布和验证边界见 [客户端说明](uploader/README.md)。推送客户端相关改动到 main 会自动测试、打包并发布同仓库更新，流程见 [GitHub 发布说明](docs/classroom-client-release.md)。

本地开发交付还会在 `uploader` 运行 `npm run pack:local`，生成 `release-local/` 中的 Local 安装包，直接从本机安装测试。本地包手动升级；GitHub 正式包继续自动更新。两种构建目录和版本标识分开，资料仍保存在安装目录之外。

网页/消息平台入口尚未绑定这个教师 profile，后续接入口时必须指向同一教师资料空间。

## 数据格式

名单使用 UTF-8 CSV：

```csv
student_id,name
s001,学生甲
s002,学生乙
```

学生 ID 是主键，允许同名学生，姓名不能作为关联主键。名单导入为追加/合并，不把缺少的行视为退班或删除。

成绩使用一种明确的 CSV 格式：

```csv
student_id,q1,q2
s001,0,6
s002,8,
```

题号、满分和知识点映射通过 `questions` 参数明确提供；可额外提供 `total` 列，程序校验与题分一致。空白表示 missing，`缺考` 表示 absent，`未批改` 表示 ungraded，数值 0 表示 scored。Excel 可导出为 UTF-8 CSV 后导入；此版未实现任意成绩表自动识别。

导入转写为 JSON：

```json
{"segments":[{"start":0,"end":8,"speaker":"SPEAKER_00","text":"课堂原话"}]}
```

已有转写可以直接导入，但不会被标成已验证原录音。文档导入保存原件；当前文本读取支持 UTF-8 TXT/Markdown，其他格式暂作归档。

## 本地开发

核心代码仅使用 Python 标准库，建议 Python 3.11+；原生插件运行环境使用已有 Hermes。没有新增 ASR 模型、向量库、SQL 服务或 PPT 引擎。

```powershell
py -X utf8 -m unittest discover -s tests -v
py -m workbench.cli --root .local/demo status
py scripts/build_bundle.py
```

配置示例见 `config/teacher-workbench.example.json`；实际配置放在教师 profile 的 `teacher-workbench.json`，不提交运行数据或凭据。

| 内容 | 路径 |
|---|---|
| 原生入口与钩子 | `__init__.py`、`plugin.yaml`、`workbench/native.py` |
| 教学规则 | `skills/teacher-workbench/SKILL.md` |
| 业务数据与校验 | `workbench/schema.sql`、`facts.py`、`storage.py` |
| 查询与产物 | `query.py`、`artifacts.py` |
| 既有能力适配 | `speech.py`、`courseware.py` |
| 管理与运维 | `cli.py`、`maintenance.py`、`docs/operations.md` |
| 实测证据 | `docs/acceptance.md`、`examples/` |

工具和钩子分工见 `docs/design.md`。全部测试资料均为虚构材料。真实课堂准确率、数学教学效果和 WPS 放映需在实际使用中验收。
