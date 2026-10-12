# 课堂连接 · Windows 客户端 0.1.0

从 DJI Mic Mini 2S 等录音设备读取**已经保存的音频文件**，先复制到本机，再上传至爱马仕资料库。没有麦克风采集、音频设备通道、录音按钮或录音引擎。安装包为 Windows x64 NSIS EXE，安装后的窗口关闭时留在系统托盘，托盘菜单可以真正退出。

## 架构与开发

```mermaid
flowchart LR
    UI[React / TypeScript 界面] --> B[ClientAPI]
    B --> P[浏览器虚构数据预览]
    B --> E[Electron preload / 主进程]
    USB[录音设备文件存储] --> E
    E --> Q[本机 SQLite 队列 / 录音副本]
    Q --> H[可选 HTTP 接收入口]
    H --> S[既有 Hermes Store / 原件]
    S --> T[教师 Hermes 工具 / 既有 ASR]
    S --> R[只读处理状态查询]
    R --> E
```

界面只依赖 `src/types.ts` 中的 `ClientAPI`。浏览器使用 `src/bridge.ts` 的**明确标注为虚构数据**的预览适配器；Electron 使用 `electron/preload.cjs` 的原生桥，文件、SQLite、网络凭据及更新都在主进程处理。页面的 Node 集成关闭，开启上下文隔离和沙箱；打包后通过本地 `classroom://app` 协议加载同一份 Vite 产物。以后增加教室面板操作时，可以添加页面和独立的设备适配器，继续使用这个边界。

要求 Node.js 24+、npm；测试接收端还需要 Python 3.11+。开发不连接真实教师资料或 ASR。

```powershell
cd D:\hermes-teacher\uploader
npm ci
npm run dev        # http://127.0.0.1:5178，浏览器界面预览
npm run desktop    # 同一开发界面，启用实际 Electron 文件能力
npm run check      # TypeScript / 构建、Node 队列与传输测试、浏览器交互
node tests/electron-smoke.cjs
npm run pack:local # release-local/Hermes-Classroom-Local-<本地版本>-x64-Setup.exe
# pack:win 留给正式发布构建：release/Hermes-Classroom-<正式版本>-x64-Setup.exe
```

浏览器测试首次运行前执行 `npx playwright install chromium`。Windows 本机只有 Python launcher 时使用 `py`；CI 使用 `python`。Electron 下载使用 npm 官方包内的校验值；没有把二进制、node_modules、构建目录或运行资料提交到 Git。

本地开发交付包含可直接安装的 EXE，使用 `npm run pack:local`，无需去 GitHub 下载。它写入独立的 `release-local/`，版本带 `-local.<UTC时间>`；只修改打包后的版本信息，不修改源码版本或 lockfile，不发布 Release，不自动检查或下载 GitHub 更新。设置页标明本地包，后续安装新生成的本地 EXE 即可升级。

本地包与正式包使用同一应用身份和用户资料目录，可以手动覆盖安装并保留队列、录音副本和连接设置；安装正式包后恢复 GitHub 自动更新。两种构建输出分别管理，不提交任何安装包或运行数据。

## 首次使用

1. 在“连接与设置”填写接收端地址、教师空间 ID；接收端配置了 Bearer 凭据时填写同一凭据。
2. 用数据线或设备支持的导出连接接入设备，在“设备管理”绑定磁盘中的录音目录。绑定可移动卷的稳定 ID，盘符变化后仍可匹配；另一个设备占用旧盘符不会继承绑定。也可绑定普通录音文件夹。
3. 客户端每 4 秒扫描，等待文件大小、修改时间等在两次观察中稳定，并在复制前后检查是否仍相同。复制到 staging，流式计算内容 SHA-256，fsync 后改名，再登记队列。显示“本地副本已就绪”后，**当前扫描到的文件**无需继续连接设备即可上传。
4. 上传每次发送最多 4 MiB，从接收端已持久化的字节偏移继续；暂时离线时按退避间隔重试，凭据/协议错误显示“需要处理”。队列、偏移及回执在退出、重启和升级后保留。
5. 爱马仕实际保存原件后才返回包含 `upload_id + sha256 + byte_length + workspace_id + asset_id` 的回执。客户端逐项匹配后标为入库。后续查询只发 SHA-256 等标识，**不重新发送录音、不调用模型**。
6. 在 Hermes 中通过 `teacher_context overview` 找到待关联录音，创建课次并 `teacher_import link`，用既有 `teacher_job enqueue/submit_audio/poll_audio` 继续处理。文件分段与课次不同，一个课次可关联多个文件或片段；客户端不猜班级、学生和课次。

仅按扩展名识别常用音频文件，不增加既有教师导入的媒体、大小或目录门槛。设备原件不会删除。相同内容改名不会重复入库，同名内容变化会成为另一条录音；文件名、大小和修改时间只是便于跳过已见文件的快速索引，时间重置等情况下若所有元数据都碰巧相同，可能漏检，需真实设备验收。没有设备提供的“录制完成”信号，因此文件稳定性判断也需要真机验证；USB 导出时能否继续内录尚未确认。

设备循环覆盖之前未复制的录音无法恢复。本版保留全部本地副本，尚未实现保留天数或自动清理；不要删除未收到匹配回执的 staging 文件。解除设备绑定只移除绑定，不删除副本或队列。

## 数据位置与凭据

默认数据目录使用 Electron `app.getPath('userData')`，Windows 通常在 `%APPDATA%\Hermes Classroom`，实际路径可在设置中查看。目录内是 `queue.sqlite`、WAL 以及 `staging/`，与安装目录、Git 仓库分开。卸载器保留应用数据；更新不会迁移或清空队列。显式 `--user-data-dir=<绝对目录>` 可选择独立验收空间。

连接凭据用 Electron `safeStorage`（Windows DPAPI）加密，仅主进程解密使用。界面只能看到“是否已保存”，不会回读明文；源码、日志和发布资产都不包含凭据。浏览器预览不保存或使用输入的凭据。

## 可选接收入口

`workbench/ingress.py` 是标准库 HTTP 入口，使用既有 Store，**没有新增 ASR、模型或自动复盘调度**。本次只在临时虚构资料目录运行它，没有安装到既有宿主或重启 Hermes。正式接入时必须使用同一教师空间配置和数据根目录。

在仓库根目录开发验证，可指定仓库外的临时目录：

```powershell
py -X utf8 -m workbench.ingress --root "$env:TEMP\fictional-classroom-receiver" --port 8766
```

默认只监听 `127.0.0.1`。实际跨机器使用时由已有内网/ZeroTier或反向代理接入，必要时用 `--host` 指定监听地址。Bearer 凭据从 `HERMES_UPLOADER_TOKEN` 环境变量读取，保持在运行环境中，不写入仓库。服务不打印凭据、录音名称或业务正文到访问日志；无需 Docker socket 或修改 Hermes 核心。运行该独立入口的具体自启与网络部署留待正式接入。

协议 v1：

| 请求 | 数据 / 持久化条件 |
| --- | --- |
| `GET /v1/health` | 协议版本和教师空间 ID |
| `POST /v1/uploads` | JSON 内容标识、长度、文件名、客户端及教师空间；返回稳定上传 ID、已保存偏移、可选最终回执 |
| `PUT /v1/uploads/<id>?offset=N` | 二进制段；文件 fsync 之后提交 SQLite 偏移。崩溃尾部在下次写入前按已提交偏移截断 |
| `POST /v1/uploads/<id>/complete` | 验证本次新传输的内容完整性，调用 Store.ingest 保存原件，再提交回执。校验不复核已保存原件 |
| `GET /v1/uploads/<id>` | 当前偏移及最终回执 |
| `POST /v1/status` | JSON `{workspace_id, sha256: [...]}`；读取原件、课次、转写、任务及当前版本有效的复盘记录 |

完成入库但最终回执丢失时，客户端重复创建同一内容的会话即可取回回执，无需重传。原件提交后、回执提交前崩溃，也可以通过内容去重恢复。部分传输丢失时退回 0 重传；未知、不匹配回执不会使本地资料完成。

状态包括待关联课次、已入库、等待处理、转写中、转写已保存、复盘中、复盘已保存、复盘待刷新和需核查。复盘状态来自真实已保存且来源版本仍有效的报告，不由任务文本或 HTTP 接受决定。教师更正后旧产物 stale，下一次元数据查询就会显示待刷新。离线显示缓存并注明更新时间，不把未知状态显示成完成。

## GitHub Actions 构建与公开更新

源码仓库 `buyun00/Relay-teacher-workbench` 已公开，安装包直接发布在同一仓库的 Releases。无需另建仓库、配置发布变量或保存个人 Token：仅发布 job 获得同仓库 `GITHUB_TOKEN` 的 `contents: write`，测试/构建 job 为只读；发布凭据不会传给打包步骤或进入 EXE。

修改后提交并 **push 到 main**，相关源码变更会自动触发 `.github/workflows/classroom-client.yml`：

1. 从 `package.json` 取得主版本/次版本，用 GitHub workflow 的 `run_number` 作为补丁版本。例如源码 `0.1.0`、运行编号 `42` 生成 `0.1.42`；自动同步本次工作目录的 lockfile，不回写版本提交、不需要手工打标签。重跑同一 run 保持同一版本，编号允许跳号。
2. Windows runner 执行 Python、队列/传输/发布规则、浏览器和 Electron 开发运行检查，再打 NSIS x64 包；随后用真实打包 EXE 复验复制、拔盘后上传、回执和重启。
3. 核对 `latest.yml` 与 EXE 的版本、文件大小、SHA-512，生成 `build-info.json` 记录源码 SHA 和资产 SHA-256；构建 artifact 保留 14 天。
4. 在同仓库创建 `v0.1.42` 草稿 Release，上传 EXE、blockmap、latest.yml 和 build-info.json。GitHub 确认全部资产的长度和 SHA-256 后，才公开为最新版本。失败留在草稿，不被客户端发现。

PR 只构建/测试，不公开更新。手动运行 workflow 默认只构建；在 main 勾选 publish 可发布。发布前后检查 main 提交，过时构建不会发布；较旧版本重跑也不会抢占最新版本。已经公开的同一版本不覆盖安装包，重跑会保留原 Release。并发 main 构建按队列执行，PR 新提交可取消旧检查。

正式 CI 包的默认更新地址是 `buyun00/Relay-teacher-workbench`；`pack:local` 的本地包关闭 GitHub 更新。最初制作的 0.1.0 包没有内置这个地址，需要在“连接与设置”填一次；之后的 CI 版本自带地址。以后升级主/次版本时修改 package.json 与 lockfile；保持 workflow 文件路径稳定以保留运行编号。Windows 版本各段必须不超过 65535。完整开发、恢复和凭据说明见 [发布流程](../docs/classroom-client-release.md)。

正式安装版启动后检查更新，此后每 6 小时检查；自动下载新包，下载好后发系统提示，并在设置页提供“安装更新并重启”。持续两分钟没有下载进展时取消，提示检查 GitHub 下载连接并允许重试，不影响录音传输。**下载完成、关闭窗口或退出都不会自动安装**。复制/扫描期间禁用安装；安装前暂停并结束本次网络操作，保留队列和用户的暂停偏好，再启动新版本。浏览器、Electron 开发运行和本地安装包不会下载安装更新。

本机可复用 Git Credential Manager 已保存的 GitHub 登录完成首次部署；不用把 Token 粘贴到聊天、源码或安装包。当前 EXE 未做 Authenticode 签名。代码签名证书是后续改善 Windows 安装体验的独立配置，不是当前自动打包/更新所需凭据。远端首次运行和公开更新的实测结果记录在 `docs/acceptance.md`。

实现依据：[Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)、[上下文隔离与安全](https://www.electronjs.org/docs/latest/tutorial/security)、[electron-builder 自动更新](https://www.electron.build/docs/features/auto-update/)、[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。

## 验收边界

`tests/*.test.cjs` 使用临时虚构文件与实际 Python HTTP 接收入口，覆盖改名去重、同名替换、复制中变化、稳定观察、重启、丢失副本、盘符复用、分段续传、回执丢失/不匹配、凭据错误和更新安装时机。`tests/ui` 验证浏览器数据标识、暂停、筛选、搜索、详情及预览凭据不落盘；`tests/electron-smoke.cjs` 检查真实 Electron 界面协议、沙箱、桥、SQLite 与 Windows 凭据加密，并通过真实文件复制、移除模拟设备目录后上传、查询回执/状态及重启验证。

检查构建后的实际 EXE 时设置 `CLASSROOM_PACKAGED_EXE` 指向 `release/win-unpacked/Hermes Classroom.exe`，再运行同一脚本。脚本通过显式独立 user-data-dir 使用临时虚构数据，不触碰默认教师资料或系统登录启动设置。

Python 原生工具和虚构教学资料测试保留，接收端增加事务/偏移恢复、实际 HTTP、版本过期和教师工具发现新录音的检查。本轮没有使用真实学生或课堂资料，没有调用真实 ASR，也没有验证实际 DJI 硬件、现场录音导出、正式宿主接收、公开更新或跨版本安装。之前插件的真实 ASR/课件验收不能替代这个客户端链路的验收。
