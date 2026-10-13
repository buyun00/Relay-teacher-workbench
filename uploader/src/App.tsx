import { useEffect, useState } from "react";
import {
  Archive, ArchiveRestore, Check, ChevronDown, CircleAlert, FileAudio2, FolderOpen,
  LoaderCircle, MessageSquare, Mic, Pause, Play, Plus, Settings2,
  UploadCloud, X,
} from "lucide-react";
import { bridge } from "./bridge";
import type { Snapshot } from "./types";
import { Chat } from "./Chat";
import { WindowTitleBar } from "./WindowTitleBar";
import { UpdateBanner } from "./UpdateBanner";
import { RecordingWorkspace } from "./RecordingWorkspace";

type Run = (action: () => Promise<unknown>, success?: string) => Promise<void>;

export function App() {
  const [s, setSnapshot] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<"chat" | "uploads" | "review" | "history" | "schedule">("chat");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [fatal, setFatal] = useState("");
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const visibleTasks = s?.tasks.filter((item) => !!item.archived_at === showArchived) || [];
  const task = visibleTasks.find((item) => item.id === taskId) || visibleTasks[0];
  useEffect(() => {
    let live = true;
    void bridge.snapshot().then((value) => {
      if (live) setSnapshot(value);
    }).catch(() => setFatal("读取本地资料失败，请重新打开客户端"));
    const unsubscribe = bridge.subscribe(setSnapshot);
    return () => { live = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const online = () => { if (window.classroom) void bridge.checkUpdates().catch(() => {}); };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, []);
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
  const newTask = () => {
    setCreating(true);
    void run(async () => {
      const created = await bridge.createTask();
      setTaskId(created.id);
      setShowArchived(false);
      setPage("chat");
    }).finally(() => setCreating(false));
  };
  const archiveTask = (id: string, archived: boolean) => void run(async () => {
    await bridge.archiveTask({ id, archived });
    if (!archived) { setShowArchived(false); setTaskId(id); setPage("chat"); }
  }, archived ? "对话已归档，随时可以恢复" : "对话已恢复");
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
  if (!s) return <div className="desktop-layout"><WindowTitleBar /><div className="startup">{fatal || "正在打开…"}</div></div>;
  const pending = s.files.filter((file) => file.state !== "received").length;
  return (
    <div className="desktop-layout">
    <WindowTitleBar />
    <UpdateBanner snapshot={s} run={run} />
    <div className="app-shell">
      <aside className="sidebar">
        <button className="new-task" disabled={creating} onClick={newTask}>{creating ? <LoaderCircle size={17} className="spin" /> : <Plus size={17} />}新建任务</button>
        <div className="task-label">{showArchived ? "已归档" : "对话"}<span>{visibleTasks.length || ""}</span></div>
        <nav className="task-list" aria-label="任务列表">
          {visibleTasks.length ? visibleTasks.map((item) => (
            <div key={item.id} data-chat-id={item.id} className={"task-row " + (page === "chat" && task?.id === item.id ? "selected" : "")}>
            <button title={item.title} className="task-item" onClick={() => { setTaskId(item.id); setPage("chat"); }}>
              {["queued", "running", "cancelling"].includes(item.state || "") ? <LoaderCircle size={15} className="spin" /> : <MessageSquare size={15} />}<span>{item.title}</span>
            </button>
            <button className="task-action" title={showArchived ? "恢复对话" : "归档对话"}
              aria-label={(showArchived ? "恢复对话：" : "归档对话：") + item.title}
              onClick={() => archiveTask(item.id, !showArchived)}>{showArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}</button>
            </div>
          )) : <p className="no-tasks">{showArchived ? "还没有归档的对话" : "还没有对话，从一个想法开始"}</p>}
        </nav>
        <div className="sidebar-footer">
          <button className={"sidebar-link archive-toggle " + (showArchived ? "selected" : "")} aria-label={showArchived ? "返回对话" : "已归档对话"}
            onClick={() => { setShowArchived(!showArchived); setTaskId(null); setPage("chat"); }}>
            {showArchived ? <MessageSquare size={17} /> : <Archive size={17} />}<span>{showArchived ? "返回对话" : "已归档"}</span>
            {!showArchived && s.tasks.some((item) => item.archived_at) && <b>{s.tasks.filter((item) => item.archived_at).length}</b>}
          </button>
          <button className={"sidebar-link " + (page === "uploads" ? "selected" : "")} aria-label="录音上传"
            onClick={() => setPage("uploads")}>
            <FileAudio2 size={17} /><span>录音整理</span>{pending > 0 && <b aria-hidden="true">{pending}</b>}
          </button>
          <button className={"sidebar-link " + (page === "history" ? "selected" : "")} onClick={() => setPage("history")}><Archive size={17}/><span>课程历史</span></button>
          <button className={"sidebar-link " + (page === "schedule" ? "selected" : "")} onClick={() => setPage("schedule")}><Settings2 size={17}/><span>课表</span></button>
          <button className="sidebar-link" aria-label="设置" onClick={() => setSettings(true)}><Settings2 size={17} /><span>设置</span></button>
          {s.mode === "preview" && <small className="preview-label">浏览器预览 · 虚构数据</small>}
        </div>
      </aside>
      <main className="main-pane">
        {page === "chat" ? (
          <Chat key={task?.id || "empty"} task={task} snapshot={s} run={run} disabled={creating} />
        ) : (
          <RecordingWorkspace snapshot={s} run={run} page={page} navigate={setPage} openSettings={() => setSettings(true)}
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
                {s.update.state === "local" ? "本地包手动升级" : s.update.state === "downloaded" ? "重启启用新内容" : "检查更新"}
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
