import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowUp, Check, ChevronDown, CircleAlert, FileAudio2, FolderOpen,
  LoaderCircle, MessageSquare, Mic, Pause, Play, Plus, Settings2,
  UploadCloud, X,
} from "lucide-react";
import { bridge } from "./bridge";
import type { Recording, RecordingResults, Snapshot } from "./types";

type Run = (action: () => Promise<unknown>, success?: string) => Promise<void>;
const size = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : (n / 1e3).toFixed(1) + " KB";
const fileLabel = (file: Recording) => {
  if (file.state === "received") return ({ queued: "等待处理", transcribing: "正在转写",
    transcribed: "转写已保存", analyzing: "正在生成复盘", analyzed: "处理完成",
    stale: "结果需刷新", needs_attention: "处理需检查" } as Record<string, string>)[file.remote?.state || ""] || "已上传";
  if (file.state === "uploading") return "正在上传";
  if (file.state === "retry") return "等待重试";
  if (file.state === "missing") return "本地副本缺失";
  if (file.state === "attention") return "上传失败";
  return "等待上传";
};

export function App() {
  const [s, setSnapshot] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<"chat" | "uploads">("chat");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [settings, setSettings] = useState(false);
  const [adding, setAdding] = useState(false);
  const [fatal, setFatal] = useState("");
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const task = s?.tasks.find((item) => item.id === taskId) || s?.tasks[0];
  useEffect(() => {
    let live = true;
    void bridge.snapshot().then((value) => {
      if (live) setSnapshot(value);
    }).catch(() => setFatal("读取本地资料失败，请重新打开客户端"));
    const unsubscribe = bridge.subscribe(setSnapshot);
    return () => { live = false; unsubscribe(); };
  }, []);
  useEffect(() => { setDraft(task?.draft || ""); }, [task?.id]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSettings(false); setToast(null); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  const run: Run = async (action, success) => {
    try {
      await action();
      if (success) setToast({ message: success, error: false });
    } catch (error) {
      const message = error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "")
        : "操作失败，请稍后再试";
      setToast({ message, error: true });
    }
  };
  const newTask = () => void run(async () => {
    const created = await bridge.createTask();
    setTaskId(created.id);
    setPage("chat");
  });
  const addFiles = async () => {
    setAdding(true);
    try {
      await run(async () => {
        const result = await bridge.selectFiles();
        if (!result) return;
        let message = "新增 " + result.added + " 份录音；重复 " + result.duplicates + " 份";
        if (result.failed.length)
          message += "；" + result.failed.length + " 份添加失败：" + result.failed[0].filename + " · " + result.failed[0].detail;
        else message += "；本地副本已就绪";
        setToast({ message, error: result.failed.length > 0 });
      });
    } finally { setAdding(false); }
  };
  if (!s) return <div className="startup">{fatal || "正在打开…"}</div>;
  const pending = s.files.filter((file) => file.state !== "received").length;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="app-name">课堂连接</div>
        <button className="new-task" onClick={newTask}><Plus size={17} />新建任务</button>
        <div className="task-label">任务</div>
        <nav className="task-list" aria-label="任务列表">
          {s.tasks.length ? s.tasks.map((item) => (
            <button key={item.id} title={item.title} className={"task-item " + (page === "chat" && task?.id === item.id ? "selected" : "")}
              onClick={() => { setTaskId(item.id); setPage("chat"); }}>
              <MessageSquare size={15} /><span>{item.title}</span>
            </button>
          )) : <p className="no-tasks">还没有任务</p>}
        </nav>
        <div className="sidebar-footer">
          <button className={"sidebar-link " + (page === "uploads" ? "selected" : "")} aria-label="录音上传"
            onClick={() => setPage("uploads")}>
            <FileAudio2 size={17} /><span>录音上传</span>{pending > 0 && <b aria-hidden="true">{pending}</b>}
          </button>
          <button className="sidebar-link" aria-label="设置" onClick={() => setSettings(true)}><Settings2 size={17} /><span>设置</span></button>
          {s.mode === "preview" && <small className="preview-label">浏览器预览 · 虚构数据</small>}
        </div>
      </aside>
      <main className="main-pane">
        {page === "chat" ? (
          <div className="chat-view">
            <header className="pane-header"><h1>{task?.title || "新任务"}</h1></header>
            <div className="conversation">
              <div className="conversation-empty">
                <MessageSquare size={27} strokeWidth={1.3} />
                <h2>{task ? "对话功能将在下一步接入" : "从左侧新建一个任务"}</h2>
                <p>{task ? "现在可以保存消息草稿，也可以先测试录音上传。" : "在这里处理任务，在录音上传页添加课堂录音。"}</p>
              </div>
            </div>
            <div className="composer-area">
              <div className="composer">
                <textarea aria-label="消息草稿" value={draft} disabled={!task}
                  placeholder={task ? "输入消息，暂存为草稿…" : "先新建一个任务"}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDraft(value);
                    if (task) void run(() => bridge.saveTaskDraft({ id: task.id, draft: value }));
                  }} />
                <div className="composer-bottom"><small>对话服务下一步接入</small><button className="send-button" disabled aria-label="发送消息" title="对话服务尚未接入"><ArrowUp size={18} /></button></div>
              </div>
              {task && draft && <span className="draft-note">{task.draft === draft ? "草稿已保存在本机" : "正在保存草稿…"}</span>}
            </div>
          </div>
        ) : (
          <Uploads snapshot={s} run={run} openSettings={() => setSettings(true)}
            uploadButton={<button className="button primary" disabled={adding || s.scanning || !!s.copying} onClick={() => void addFiles()}>
              {adding ? <LoaderCircle size={16} className="spin" /> : <UploadCloud size={16} />}
              {adding ? "正在添加…" : "手动上传"}
            </button>} />
        )}
      </main>
      {settings && <SettingsDialog snapshot={s} run={run} close={() => setSettings(false)} />}
      {toast && <div className={"toast " + (toast.error ? "error" : "")} role={toast.error ? "alert" : "status"}>
        {toast.error ? <CircleAlert size={17} /> : <Check size={17} />}
        <span>{toast.message}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={15} /></button>
      </div>}
    </div>
  );
}

function Uploads({ snapshot: s, run, openSettings, uploadButton }: {
  snapshot: Snapshot; run: Run; openSettings: () => void; uploadButton: ReactNode;
}) {
  const [results, setResults] = useState<{ filename: string; value: RecordingResults } | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setResults(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  const connected = s.devices.filter((device) => device.connected);
  const deviceProblem = connected.find((device) => device.problem)?.problem;
  const uncollected = connected.reduce((total, device) => total + (device.pending || 0), 0);
  const pending = s.files.filter((file) => file.state !== "received");
  const active = s.files.find((file) => file.state === "uploading");
  const failed = pending.filter((file) => ["attention", "missing"].includes(file.state));
  const complete = s.files.filter((file) => file.state === "received").length;
  const processing = s.files.find((file) => file.state === "received" && ["queued", "transcribing", "transcribed", "analyzing"].includes(file.remote?.state || ""));
  const analysisIssue = s.files.some((file) => ["needs_attention", "stale"].includes(file.remote?.state || ""));
  const analyzed = s.files.filter((file) => file.remote?.workflow?.complete).length;
  const deviceLabel = s.deviceState === "error" ? "设备识别暂不可用" : s.deviceState === "checking" ? "正在检查设备" :
    deviceProblem ? "已接入，读取遇到问题" : connected.length ? "已接入" : s.candidates.length ? "已检测到设备，请选择录音目录" : "未接入";
  const status = s.config.pauseUploads ? "已暂停" : s.copying ? "正在保存录音" : active ? "正在上传" :
    !s.config.endpoint && s.mode !== "preview" && pending.length ? "等待连接设置" :
    failed.length || deviceProblem ? "有录音需要处理" : pending.length ? "等待上传，自动重试" : uncollected ? "正在读取设备录音" :
    complete ? processing ? "已上传，" + fileLabel(processing) : analysisIssue ? "已上传，处理需检查" : analyzed === complete ? "上传和处理完成" : "全部上传完成" : "等待录音";
  const progress = active ? Math.min(100, Math.round(active.uploadedBytes / Math.max(1, active.bytes) * 100)) : 0;
  return (
    <div className="upload-view">
      <header className="pane-header"><h1>录音上传</h1>{uploadButton}</header>
      <div className="upload-content">
        <p className="page-description">插入设备自动上传，或选择本机音频文件。上传后自动转写并保存复盘、备课。</p>
        <section className="status-panel" aria-label="录音上传状态">
          <div className="status-row">
            <div className="status-label"><Mic size={18} /><span>录音设备</span></div>
            <div className="status-value"><strong>{deviceLabel}</strong>
              {deviceProblem && <small>{deviceProblem}</small>}
              <button className="text-button" disabled={s.scanning || !!s.copying} onClick={() => void run(() => bridge.selectFolder())}>选择录音目录</button>
            </div>
          </div>
          <div className="status-row">
            <div className="status-label"><FileAudio2 size={18} /><span>待上传录音</span></div>
            <div className="status-value"><strong>{pending.length ? pending.length + " 份" : s.deviceState === "error" || deviceProblem ? "暂时无法确认" : s.scanning || s.deviceState === "checking" ? "正在检查" : "没有待上传录音"}</strong>
              {uncollected > 0 && <small>设备中还有 {uncollected} 份正在读取</small>}
            </div>
          </div>
          <div className="status-row">
            <div className="status-label"><UploadCloud size={18} /><span>上传状态</span></div>
            <div className="status-value"><strong className={active ? "active-status" : ""}>{status}</strong>
              {(pending.length > 0 || s.config.pauseUploads) && <button className="text-button"
                onClick={() => void run(() => bridge.pause(!s.config.pauseUploads))}>
                {s.config.pauseUploads ? <Play size={13} /> : <Pause size={13} />}{s.config.pauseUploads ? "继续上传" : "暂停上传"}
              </button>}
            </div>
          </div>
          {(active || s.copying) && <div className="upload-progress">
            <div><span>{s.copying?.filename || active?.filename}</span><b>{s.copying ? size(s.copying.copied) + " / " + size(s.copying.bytes) : progress + "%"}</b></div>
            <div className="progress-track"><i style={{ width: (s.copying ? Math.min(100, s.copying.copied / Math.max(1, s.copying.bytes) * 100) : progress) + "%" }} /></div>
          </div>}
        </section>
        {(!s.config.endpoint && s.mode !== "preview") && <div className="connection-note"><CircleAlert size={16} /><span>上传前，请设置录音接收地址。已添加的文件会留在本机等待。</span><button className="text-button" onClick={openSettings}>打开设置</button></div>}
        {s.connection.state === "offline" && s.config.endpoint && <p className="muted connection-error">{s.connection.detail}</p>}
        {s.files.length > 0 && <details className="file-details">
          <summary>录音文件（{s.files.length}）<ChevronDown size={15} /></summary>
          <div className="file-list">
            <div className="file-actions"><button className="text-button" onClick={() => void run(() => bridge.refreshStatus())}>刷新状态</button></div>
            {s.files.map((file) => <div className="file-row" key={file.id}>
              <FileAudio2 size={17} />
              <div className="file-info"><strong title={file.filename}>{file.filename}</strong><small>{file.sourceName} · {size(file.bytes)}</small>
                {file.error && file.state !== "received" && <p className="file-error">{file.error}</p>}
                {file.remote?.workflow?.error && <p className="file-error">{file.remote.workflow.error}</p>}
              </div>
              <span className={"file-status " + file.state}>{fileLabel(file)}</span>
              {!!file.remote?.workflow?.artifacts.length && <button className="text-button" disabled={reading === file.id}
                onClick={() => void run(async () => {
                  setReading(file.id);
                  try { setResults({ filename: file.filename, value: await bridge.readResults(file.id) }); }
                  finally { setReading(null); }
                })}>{reading === file.id ? "正在读取…" : "查看结果"}</button>}
              {["attention", "missing", "retry"].includes(file.state) && <button className="text-button" onClick={() => void run(() => bridge.retry(file.id))} aria-label={"重试 " + file.filename}>重试</button>}
            </div>)}
          </div>
        </details>}
      </div>
      {results && <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setResults(null); }}>
        <section className="settings-dialog results-dialog" role="dialog" aria-modal="true" aria-labelledby="results-title">
          <header><h2 id="results-title">录音处理结果</h2><button className="icon-button" aria-label="关闭结果" onClick={() => setResults(null)}><X size={19} /></button></header>
          <div className="results-content"><p className="muted">{results.filename}</p>
            {!results.value.complete && <p>处理尚未全部完成，以下为已保存的结果。</p>}
            {results.value.reports.map((report) => <article key={report.id}>
              <span className="report-kind">{report.kind === "brief" ? "课堂复盘" : "补充备课"}</span>
              <h3>{report.title}</h3>{report.warning && <p className="file-error">{report.warning}</p>}
              <pre>{report.text.split("\n\n---\n来源版本：")[0]}</pre>
            </article>)}
          </div>
        </section>
      </div>}
    </div>
  );
}

function SettingsDialog({ snapshot: s, run, close }: { snapshot: Snapshot; run: Run; close: () => void }) {
  const [endpoint, setEndpoint] = useState(s.config.endpoint);
  const [workspaceId, setWorkspaceId] = useState(s.config.workspaceId);
  const [token, setToken] = useState("");
  const [releaseRepo, setReleaseRepo] = useState(s.config.releaseRepo);
  const [login, setLogin] = useState(s.config.startAtLogin);
  const [saving, setSaving] = useState(false);
  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header><h2 id="settings-title">设置</h2><button className="icon-button" aria-label="关闭设置" onClick={close}><X size={19} /></button></header>
        <form onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          void run(async () => {
            try {
              await bridge.saveSettings({ endpoint, workspaceId, token: token || undefined, releaseRepo, startAtLogin: login });
              setToken("");
            } finally { setSaving(false); }
          }, "设置已保存");
        }}>
          <label>录音接收地址<input autoFocus placeholder="http://服务器地址:端口" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>
          <p className="field-hint">填写 Hremes 提供的录音接收地址。</p>
          <label>教师空间 ID<input value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} /></label>
          <label>连接凭据<input type="password" autoComplete="off" placeholder={s.config.hasToken ? "已保存；留空保留" : "接收端需要时填写"} value={token} onChange={(event) => setToken(event.target.value)} /></label>
          <div className="settings-buttons"><button className="button primary" disabled={saving} type="submit">{saving ? "正在保存…" : "保存设置"}</button></div>
          <p className="field-hint" role="status">{s.connection.detail}</p>
          <details className="advanced-settings">
            <summary>更多设置<ChevronDown size={15} /></summary>
            <label className="checkbox-label"><input type="checkbox" checked={login} onChange={(event) => setLogin(event.target.checked)} />登录 Windows 后启动</label>
            <label>公开 GitHub 更新仓库<input placeholder="用户名/仓库名" value={releaseRepo} onChange={(event) => setReleaseRepo(event.target.value)} /></label>
            <div className="update-settings"><strong className="version-number">当前版本 {s.version}</strong><p className="muted">{s.update.detail}</p>
              <button type="button" className="button secondary" disabled={["local", "checking", "downloading"].includes(s.update.state) || (s.update.state === "downloaded" && (s.scanning || !!s.copying))}
                onClick={() => void run(() => s.update.state === "downloaded" ? bridge.installUpdate() : bridge.checkUpdates())}>
                {s.update.state === "local" ? "本地包手动升级" : s.update.state === "downloaded" ? "安装更新并重启" : "检查更新"}
              </button>
            </div>
            {s.config.devices.length > 0 && <div className="bound-folders"><h3>录音目录</h3>{s.config.devices.map((device) => <div key={device.id}><span title={device.originalRoot}>{device.originalRoot}</span><button type="button" className="text-button" onClick={() => void run(() => bridge.unbind(device.id))}>解除绑定</button></div>)}</div>}
            <button type="button" className="text-button" onClick={() => void run(() => bridge.openDataDir())}><FolderOpen size={14} />打开本地资料</button>
          </details>
        </form>
      </section>
    </div>
  );
}
