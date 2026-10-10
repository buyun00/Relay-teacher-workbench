# 首版验收记录

日期：2026-10-10。代码版本：0.1.0。全部资料为明确标记的虚构教学材料，不含真实学生或真实课堂数据。

| 层面 | 实测结果 |
|---|---|
| Windows / Linux 核心测试 | 23 项通过，覆盖导入去重、源文件损坏、范围限制、身份、更正、统计、检索、租约、任务产物类型、导出、删除、备份恢复 |
| Hermes 原生插件 | 已安装宿主版本 v0.21.5 的 doctor 检查通过；9 个工具、5 个钩子注册成功 |
| 模型实际调用 | 在教师 demo profile 中由现有模型实际调用工具，完成名单、两课转写、测验导入、复盘和备课保存 |
| 新会话更正 | demo_event 从 revision 1 更新至 2，身份改为 demo_s02，原因保存为教师观察，对应问题 answered |
| 旧产物失效 | 原 brief 和 preparation 均 stale=1；新查询只使用当前事件，不把另一录音中的同名 speaker 绑定到该学生 |
| 成绩统计 | q1 有效计分2人、均分4.00；q2 有效计分2人、均分5.00；零分、缺考、未批改和空白未混合 |
| 真实 ASR | Windows 已有中文语音合成生成约35秒虚构录音，提交给现有 ASR；实际返回4个带时间片段并保存原始结果；后续复盘产物保存，audio业务任务 completed |
| 已有课件能力 | Hermes 内部 classroom-ppt-coach / courseware 实际生成4页可编辑 PPTX，后台任务 completed；无需 Windows Codex 代做 |
| 课件结构 | 4页均有淡化过渡、原生点击动画及备注；点击组数分别为2、5、3、4；主正文最低28pt |
| 课件检查 | ZIP/XML重开、内部33项关系、动画目标、备注与现有 pml.xsd 检查通过；近似静态渲染4页，控制器查看总览无明显重叠或截断 |
| 执行目录权限 | 现有课件 UID 10000 可读 brief、可写任务草稿；读取教师业务数据库会被拒绝 |
| 消息绑定 | 实际原生工具调用返回本轮 msg ID；单元测试验证并发会话与过期未知 task ID 不会借用另一会话的消息 |
| 真实资料库备份恢复 | demo 空间备份恢复到新目录；revision 2、学生归属、已回答问题和完成任务均保留，SQLite integrity_check=ok，无外键错误 |
| 正式资料空间 | 教师入口实际返回 teacher、0个课次、0名学生；验收材料留在独立 fictional-demo 空间 |

持久化样例标识：

- 第一份复盘：`artifact_765e6cebd5bb4291`，更正后 stale=1。
- 第一份备课：`artifact_69c4ab9c76654d8a`，更正后 stale=1。
- 更正后备课：`artifact_7b770d16c8f54078`，当前有效。
- ASR 复盘：`artifact_49089c3a146e44c4`，当前有效。
- 最终课件：`artifact_44bfaefa8b29467d`，当前有效。
- ASR 业务任务：`job_a5e7060fcf4e4ebe`，completed。
- 最终课件任务：`job_46b20cb254c14c70`，completed。

备课和复盘实测正文保存在 `examples/preparation.md` 与 `examples/asr-review.md`。原始数据库、音频、完整会话日志与运行配置不提交 Git；本机 `.local/acceptance/` 保存导出的虚构验收证据及 PPTX。

接入测试发现并修复了当前 Hermes 快速 oneshot 的插件发现顺序、课件工作目录绑定与终端 UID 权限适配问题。先前失败的虚构课件任务保留为 needs_attention，用于证明失败不会被标为完成；修复后的新课件任务首次执行完成。正式教师资料空间没有这些测试任务。

验证边界：当前主机没有 LibreOffice/PowerPoint/WPS，既有 office/validate.py 路径也缺失，因此使用已安装的 render_qa.py、pml.xsd 和 ZIP/关系/动画检查。PNG 来自现有 Pillow 近似静态渲染器，不是 Office 截图。未进行 WPS 放映、目标电脑字体兼容、真实长课堂、多人嘈杂录音、断电或学校现场验收。备课数学例题已人工阅读并做端点/条件检查，真实教学使用仍应由教师审阅。

本次交付的是可在现有 Hermes 中运行的教师插件与资料库。妻子电脑上传器、阿里云和网页/消息平台路由尚未制作；目录监听与无人值守自动复盘调度也留在入口接入阶段。
