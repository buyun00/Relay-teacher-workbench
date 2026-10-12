import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Bell,
  Check,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  Clock3,
  Cloud,
  FileAudio2,
  FolderOpen,
  HardDrive,
  LayoutDashboard,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plug,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Unplug,
  UploadCloud,
  Usb,
  Wifi,
  X,
} from "lucide-react";
import { bridge } from "./bridge";
import type { Device, Recording, Snapshot } from "./types";

type Page = "overview" | "transfers" | "devices" | "settings";
type Run = (action: () => Promise<unknown>, success?: string) => Promise<void>;
const size = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)} GB`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} MB`
      : `${(n / 1e3).toFixed(1)} KB`;
const time = (value?: string | null) =>
  value
    ? new Date(value).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "尚未确认";
const dateTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
const remoteLabels: Record<string, string> = {
  received: "已入库",
  awaiting_lesson: "待关联课次",
  queued: "等待处理",
  transcribing: "转写中",
  transcribed: "转写已保存",
  analyzing: "复盘中",
  analyzed: "复盘已保存",
  stale: "复盘待刷新",
  needs_attention: "需核查处理",
  unknown: "接收端未找到",
};

function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand ${small ? "small" : ""}`}>
      <div className="brand-mark">
        <span />
        <span />
        <span />
        <span />
      </div>
      <div>
        <strong>课堂连接</strong>
        <span>CLASSROOM BRIDGE</span>
      </div>
    </div>
  );
}
function Status({ file }: { file: Recording }) {
  if (file.state === "received")
    return (
      <span
        className={`badge ${file.remote?.state === "analyzed" ? "green" : ["stale", "needs_attention", "unknown"].includes(file.remote?.state || "") ? "amber" : "neutral"}`}
      >
        <Check size={12} />
        {file.remote ? remoteLabels[file.remote.state] : "爱马仕已保存"}
      </span>
    );
  if (file.state === "uploading")
    return (
      <span className="badge blue">
        <LoaderCircle size={12} className="spin" />
        正在上传
      </span>
    );
  if (["retry", "attention", "missing"].includes(file.state))
    return (
      <span className="badge amber">
        <CircleAlert size={12} />
        {file.state === "retry" ? "等待重试" : "需要处理"}
      </span>
    );
  return (
    <span className="badge neutral">
      <Clock3 size={12} />
      等待上传
    </span>
  );
}
function MiniMic() {
  return (
    <div className="mic-illustration" aria-hidden="true">
      <div className="mic-shadow" />
      <div className="mic-body">
        <span className="mic-clip" />
        <span className="mic-grid" />
        <span className="mic-dot" />
        <b>DJI</b>
        <span className="mic-bottom" />
      </div>
      <span className="device-orbit orbit-one" />
      <span className="device-orbit orbit-two" />
      <span className="usb-line" />
      <Usb className="usb-symbol" size={18} />
    </div>
  );
}
function Empty({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

export function App() {
  const [s, setSnapshot] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<Page>("overview");
  const [detail, setDetail] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const [fatal, setFatal] = useState("");
  useEffect(() => {
    let live = true;
    void bridge
      .snapshot()
      .then((value) => {
        if (live) setSnapshot(value);
      })
      .catch(() => setFatal("读取本地队列失败，请重新打开客户端"));
    const unsubscribe = bridge.subscribe((value) => setSnapshot(value));
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const run: Run = async (action, success) => {
    try {
      await action();
      if (success) setToast({ message: success, error: false });
    } catch (error) {
      setToast({
        message:
          error instanceof Error
            ? error.message.replace(
                /^Error invoking remote method '[^']+': Error: /,
                "",
              )
            : "操作失败，请稍后再试",
        error: true,
      });
    }
  };
  if (!s)
    return (
      <div className="startup">
        <Brand />
        <p>{fatal || "正在读取本地队列…"}</p>
      </div>
    );
  const received = s.files.filter((f) => f.state === "received");
  const pending = s.files.length - received.length;
  const active = s.files.find((f) => f.state === "uploading");
  const connected = s.devices.filter((d) => d.connected);
  const safe = connected.length > 0 && connected.every((d) => d.safeToUnplug);
  const selected = s.files.find((f) => f.id === detail);
  const pages = {
    overview: "工作台",
    transfers: "录音传输",
    devices: "设备管理",
    settings: "连接与设置",
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace">
          <div className="workspace-icon">H</div>
          <div>
            <strong>爱马仕工作空间</strong>
            <span>{s.config.workspaceId}</span>
          </div>
          <ChevronRight size={15} />
        </div>
        <div className="nav-label">我的教室</div>
        <nav aria-label="主导航">
          {(
            [
              ["overview", LayoutDashboard, "工作台"],
              ["transfers", ArrowDownToLine, "录音传输"],
              ["devices", Usb, "设备管理"],
              ["settings", Settings2, "连接与设置"],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              className={`nav-item ${page === key ? "active" : ""}`}
              onClick={() => setPage(key)}
              aria-current={page === key ? "page" : undefined}
            >
              <Icon size={19} />
              <span>{label}</span>
              {key === "transfers" && pending > 0 && <b>{pending}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="note-spark">✦</div>
          <strong>为课堂留下一份记录</strong>
          <p>录音在本机收好，教学资料在爱马仕里持续积累。</p>
          <span>
            <ShieldCheck size={13} />
            本地副本 · 持久化回执
          </span>
        </div>
        <div className="sidebar-bottom">
          <div className="avatar">教</div>
          <div>
            <strong>教师操作端</strong>
            <span>v{s.version}</span>
          </div>
          <button
            className="icon-button"
            title="打开设置"
            aria-label="打开设置"
            onClick={() => setPage("settings")}
          >
            <MoreHorizontal size={20} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            我的教室
            <ChevronRight size={13} />
            <strong>{pages[page]}</strong>
          </div>
          <div className="topbar-right">
            {s.mode === "preview" && (
              <span className="preview-pill">浏览器预览 · 虚构数据</span>
            )}
            <span className={`connection-dot ${s.connection.state}`} />
            <span className="topbar-status">
              {s.connection.state === "online"
                ? "爱马仕已连接"
                : s.connection.state === "checking"
                  ? "正在连接"
                  : s.connection.state === "unconfigured"
                    ? "尚未配置连接"
                    : "连接待恢复"}
            </span>
            <button
              className="icon-button"
              aria-label="查看近期活动"
              title="查看近期活动"
              onClick={() => setPage("overview")}
            >
              <Bell size={18} />
            </button>
          </div>
        </header>
        <main>
          {page === "overview" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">CLASSROOM WORKSPACE</div>
                  <h1>
                    课堂记录，从这里开始<span className="heading-dot">.</span>
                  </h1>
                  <p>接入录音设备，自动保存并传送已有录音。</p>
                </div>
                <button
                  className="button secondary"
                  disabled={s.scanning}
                  onClick={() => void run(() => bridge.scan())}
                >
                  <RefreshCw size={15} className={s.scanning ? "spin" : ""} />
                  {s.scanning ? "正在扫描" : "扫描设备"}
                </button>
              </div>
              <div className="hero-grid">
                <section className="hero">
                  <div className="hero-content">
                    <span className="hero-tag">
                      <span />
                      {s.copying
                        ? "正在保存本地副本"
                        : safe
                          ? "设备文件已收好"
                          : connected.length
                            ? "设备已连接"
                            : "等待录音设备"}
                    </span>
                    <h2>
                      {s.copying
                        ? "先把录音，完整收好。"
                        : safe
                          ? "录音已在本机，可以拔出设备。"
                          : connected.length
                            ? "正在整理设备中的录音。"
                            : "接上设备，课堂录音自动归档。"}
                    </h2>
                    <p>
                      {s.copying
                        ? `${s.copying.filename} · ${size(s.copying.copied)} / ${size(s.copying.bytes)}`
                        : safe
                          ? "后续上传会从本地副本继续，不需要一直连接设备。"
                          : "用 USB 读取设备里的录音文件，首次使用时绑定录音目录。"}
                    </p>
                    <div className="hero-footer">
                      <span>
                        <CheckCheck size={16} />
                        {s.files.length} 份本地录音
                      </span>
                      <span className="hero-divider" />
                      <span>
                        <Cloud size={16} />
                        {received.length} 份接收回执
                      </span>
                      <button onClick={() => setPage("devices")}>
                        管理设备
                        <ArrowRight size={15} />
                      </button>
                    </div>
                  </div>
                  <div className="hero-visual">
                    <div className="waveform">
                      {[
                        16, 29, 46, 27, 62, 76, 43, 94, 65, 110, 81, 54, 89,
                        113, 74, 52, 90, 67, 41, 58, 26, 43, 20,
                      ].map((height, i) => (
                        <i key={i} style={{ height }} />
                      ))}
                    </div>
                    <span className="wave-caption">
                      <span />
                      FROM CLASSROOM TO HERMES
                    </span>
                  </div>
                </section>
                <section className="connection-card">
                  <div className="card-kicker">
                    <span>爱马仕接收端</span>
                    <Cloud size={17} />
                  </div>
                  <div className="connection-title">
                    <span className={`connection-dot ${s.connection.state}`} />
                    {s.connection.state === "online"
                      ? "连接正常"
                      : s.connection.state === "checking"
                        ? "正在检查连接"
                        : "等待连接"}
                  </div>
                  <p>{s.connection.detail}</p>
                  <div className="connection-meta">
                    <span>最近检查</span>
                    <strong>{time(s.connection.checkedAt)}</strong>
                  </div>
                  <button
                    className="text-button"
                    onClick={() =>
                      s.config.endpoint || s.mode === "preview"
                        ? void run(() => bridge.health())
                        : setPage("settings")
                    }
                  >
                    {s.config.endpoint || s.mode === "preview"
                      ? "检查连接"
                      : "配置连接"}
                    <ArrowRight size={14} />
                  </button>
                </section>
              </div>
              <div className="stats-grid">
                <Stat
                  label="本地已保存"
                  value={s.files.length}
                  unit="份"
                  icon={<HardDrive size={19} />}
                  foot={
                    size(s.files.reduce((n, f) => n + f.bytes, 0)) + " 录音副本"
                  }
                />
                <Stat
                  label="等待传输"
                  value={pending}
                  unit="份"
                  icon={<UploadCloud size={19} />}
                  foot={
                    s.config.pauseUploads
                      ? "上传已暂停"
                      : active
                        ? "正在传输 1 份录音"
                        : "接收端可达时自动继续"
                  }
                  accent={pending > 0}
                />
                <Stat
                  label="爱马仕已保存"
                  value={received.length}
                  unit="份"
                  icon={<CheckCheck size={19} />}
                  foot="已收到匹配的持久化回执"
                />
                <Stat
                  label="复盘已保存"
                  value={
                    received.filter((f) => f.remote?.state === "analyzed")
                      .length
                  }
                  unit="份"
                  icon={<ShieldCheck size={19} />}
                  foot="以爱马仕当前资料状态为准"
                />
              </div>
              <div className="content-grid">
                <section className="card device-overview">
                  <div className="section-heading">
                    <h3>录音设备</h3>
                    <span className="mini-label">USB STORAGE</span>
                  </div>
                  {s.devices.length ? (
                    <DeviceCard device={s.devices[0]} snapshot={s} compact />
                  ) : (
                    <Empty icon={<Usb size={25} />} title="还没有绑定设备">
                      连接设备后，选择录音所在的文件夹。
                    </Empty>
                  )}
                  <button
                    className="button secondary full"
                    onClick={() => void run(() => bridge.selectFolder())}
                  >
                    <FolderOpen size={15} />
                    {s.devices.length ? "绑定其他录音目录" : "选择录音目录"}
                  </button>
                </section>
                <section className="card recent-transfers">
                  <div className="section-heading">
                    <div>
                      <h3>近期录音</h3>
                      <p>本地复制与接收端处理分别记录</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setPage("transfers")}
                    >
                      查看全部
                      <ArrowRight size={14} />
                    </button>
                  </div>
                  <FileTable
                    files={s.files.slice(0, 5)}
                    snapshot={s}
                    onSelect={setDetail}
                    run={run}
                    compact
                  />
                  {active && (
                    <div className="transfer-footer">
                      <span className="connection-dot online" />
                      {s.config.pauseUploads
                        ? "传输已暂停"
                        : "录音正在从本地副本传输"}
                      <span>
                        {Math.min(
                          100,
                          Math.floor(
                            (active.uploadedBytes / active.bytes) * 100,
                          ),
                        )}
                        %
                      </span>
                    </div>
                  )}
                </section>
              </div>
              <section className="activity">
                <div className="activity-title">
                  <Clock3 size={16} />
                  <h3>近期活动</h3>
                  <span>最近的 3 条记录</span>
                </div>
                <div className="activity-items">
                  {s.logs.length ? (
                    s.logs.slice(0, 3).map((log) => (
                      <div key={log.id}>
                        <span className={`activity-dot ${log.level}`} />
                        <p>{log.message}</p>
                        <time>{time(log.at)}</time>
                      </div>
                    ))
                  ) : (
                    <p className="muted">
                      绑定设备后，这里会记录复制、传输和连接状态。
                    </p>
                  )}
                </div>
              </section>
            </>
          )}
          {page === "transfers" && (
            <Transfers snapshot={s} run={run} onSelect={setDetail} />
          )}
          {page === "devices" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">DEVICE LIBRARY</div>
                  <h1>设备管理</h1>
                  <p>绑定录音目录后，客户端会在设备接入时自动扫描。</p>
                </div>
                <button
                  className="button primary"
                  onClick={() => void run(() => bridge.selectFolder())}
                >
                  <FolderOpen size={16} />
                  绑定录音目录
                </button>
              </div>
              <div className="devices-grid">
                {s.devices.map((device) => (
                  <section className="card" key={device.id}>
                    <DeviceCard device={device} snapshot={s} />
                    <div className="device-actions">
                      <button
                        className="text-button"
                        disabled={s.scanning}
                        onClick={() => void run(() => bridge.scan())}
                      >
                        <RefreshCw size={14} />
                        扫描文件
                      </button>
                      <button
                        className="text-button muted"
                        disabled={s.copying?.deviceId === device.id}
                        onClick={() =>
                          void run(
                            () => bridge.unbind(device.id),
                            "设备已解除绑定，本地副本保留",
                          )
                        }
                      >
                        解除绑定
                      </button>
                    </div>
                  </section>
                ))}
              </div>
              {s.devices.length === 0 && (
                <section className="card">
                  <Empty icon={<Usb size={28} />} title="连接你的录音设备">
                    使用 USB 数据连接，选择设备磁盘中的录音文件夹。
                  </Empty>
                </section>
              )}
              {s.candidates.length > 0 && (
                <section className="card candidate-card">
                  <div className="section-heading">
                    <h3>发现可连接设备</h3>
                  </div>
                  {s.candidates.map((v) => (
                    <div className="candidate" key={v.volumeId}>
                      <Usb size={22} />
                      <div>
                        <strong>{v.name}</strong>
                        <p>{v.root}</p>
                      </div>
                      <button
                        className="button secondary"
                        onClick={() =>
                          void run(() =>
                            bridge.bindCandidate({
                              volumeId: v.volumeId,
                              name: v.name,
                            }),
                          )
                        }
                      >
                        绑定设备
                      </button>
                    </div>
                  ))}
                </section>
              )}
              <div className="info-banner">
                <ShieldCheck size={20} />
                <div>
                  <strong>设备只作为文件存储使用</strong>
                  <p>
                    客户端读取已有录音，不调用系统麦克风。设备原件会保留；循环覆盖前未复制的录音无法恢复。
                  </p>
                </div>
              </div>
            </>
          )}
          {page === "settings" && <Settings snapshot={s} run={run} />}
          <footer className="main-footer">
            <span>
              <span className="footer-mark">✦</span>课堂连接
            </span>
            <span>录音留在本地 · 处理交给爱马仕</span>
            <span>v{s.version}</span>
          </footer>
        </main>
      </div>
      {selected && (
        <Details
          file={selected}
          snapshot={s}
          close={() => setDetail(null)}
          run={run}
        />
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <CircleAlert size={17} /> : <Check size={17} />}
          <span>{toast.message}</span>
          <button aria-label="关闭提示" onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
function Stat({
  label,
  value,
  unit,
  icon,
  foot,
  accent,
}: {
  label: string;
  value: number;
  unit: string;
  icon: ReactNode;
  foot: string;
  accent?: boolean;
}) {
  return (
    <section className={`stat ${accent ? "accent" : ""}`}>
      <div className="stat-top">
        <span>{label}</span>
        <div>{icon}</div>
      </div>
      <div className="stat-value">
        {value}
        <span>{unit}</span>
      </div>
      <p>{foot}</p>
    </section>
  );
}
function DeviceCard({
  device,
  snapshot,
  compact = false,
}: {
  device: Device;
  snapshot: Snapshot;
  compact?: boolean;
}) {
  const copying = snapshot.copying?.deviceId === device.id;
  return (
    <div className={`device-card ${compact ? "compact" : ""}`}>
      <div className="device-status">
        <span className={`badge ${device.connected ? "green" : "neutral"}`}>
          {device.connected ? <Plug size={12} /> : <Unplug size={12} />}
          {device.connected ? "已连接" : "未连接"}
        </span>
        <span>{device.root}</span>
      </div>
      <MiniMic />
      <h3>{device.name}</h3>
      <p className="device-subtitle">内录文件 · USB 存储</p>
      <div className={`unplug-status ${device.safeToUnplug ? "safe" : ""}`}>
        {device.safeToUnplug ? <ShieldCheck size={17} /> : <Clock3 size={17} />}
        <div>
          <strong>
            {device.safeToUnplug
              ? "本地副本已就绪"
              : copying
                ? "正在保存本地副本"
                : device.connected
                  ? "等待扫描完成"
                  : "接入后自动继续"}
          </strong>
          <span>
            {device.safeToUnplug
              ? "当前扫描到的录音可安全拔出"
              : device.problem ||
                (copying ? "请保持设备连接" : "已保存的副本仍可继续上传")}
          </span>
        </div>
      </div>
      {copying && snapshot.copying && (
        <div className="progress">
          <i
            style={{
              width: `${(snapshot.copying.copied / snapshot.copying.bytes) * 100}%`,
            }}
          />
        </div>
      )}
      <div className="device-info">
        <span>设备录音</span>
        <strong>
          {device.connected && device.fileCount !== undefined
            ? `${device.fileCount} 份`
            : "等待读取"}
        </strong>
      </div>
      <div className="device-info">
        <span>最近扫描</span>
        <strong>{time(device.lastScanAt)}</strong>
      </div>
      {device.connected &&
        device.capacity !== undefined &&
        device.freeBytes !== undefined && (
          <div className="disk-capacity">
            <div className="progress">
              <i
                style={{
                  width: `${(1 - device.freeBytes / device.capacity) * 100}%`,
                }}
              />
            </div>
            <p>
              已用 {size(device.capacity - device.freeBytes)} /{" "}
              {size(device.capacity)}
            </p>
          </div>
        )}
    </div>
  );
}
function FileTable({
  files,
  snapshot,
  onSelect,
  run,
  compact = false,
}: {
  files: Recording[];
  snapshot: Snapshot;
  onSelect: (id: string) => void;
  run: Run;
  compact?: boolean;
}) {
  if (!files.length)
    return (
      <Empty icon={<FileAudio2 size={25} />} title="还没有录音">
        连接设备并绑定录音目录后，文件会出现在这里。
      </Empty>
    );
  return (
    <div className={`file-table ${compact ? "compact" : ""}`}>
      <div className="table-head">
        <span>录音文件</span>
        <span>状态</span>
        <span>传输</span>
        <span />
      </div>
      {files.map((file) => (
        <div className="file-row" key={file.id}>
          <button className="file-identity" onClick={() => onSelect(file.id)}>
            <span
              className={`audio-icon ${file.state === "uploading" ? "sending" : ""}`}
            >
              <FileAudio2 size={20} />
            </span>
            <span>
              <strong title={file.filename}>{file.filename}</strong>
              <small>
                {dateTime(file.modifiedAt)}
                <i>·</i>
                {size(file.bytes)}
                {!compact && (
                  <>
                    <i>·</i>
                    {file.sourceName}
                  </>
                )}
              </small>
            </span>
          </button>
          <div className="file-status">
            <Status file={file} />
            {file.state === "received" && (
              <small>
                {snapshot.connection.state === "offline" ? "缓存 · " : ""}
                {file.remoteCheckedAt
                  ? `${time(file.remoteCheckedAt)} 更新`
                  : "等待状态查询"}
              </small>
            )}
          </div>
          <div className="file-progress">
            {file.state === "received" ? (
              <span className="transfer-done">
                <CheckCheck size={15} />
                已入库
              </span>
            ) : (
              <>
                <span>
                  {snapshot.config.pauseUploads
                    ? "已暂停"
                    : `${Math.floor((file.uploadedBytes / file.bytes) * 100)}%`}
                </span>
                <div className="progress">
                  <i
                    style={{
                      width: `${(file.uploadedBytes / file.bytes) * 100}%`,
                    }}
                  />
                </div>
              </>
            )}
          </div>
          <div className="row-actions">
            {["retry", "attention"].includes(file.state) ? (
              <button
                className="icon-button"
                title={`重试 ${file.filename}`}
                aria-label={`重试 ${file.filename}`}
                onClick={() => void run(() => bridge.retry(file.id))}
              >
                <RefreshCw size={15} />
              </button>
            ) : (
              <button
                className="icon-button"
                aria-label={`查看 ${file.filename}`}
                title="录音详情"
                onClick={() => onSelect(file.id)}
              >
                <ChevronRight size={16} />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
function Transfers({
  snapshot: s,
  run,
  onSelect,
}: {
  snapshot: Snapshot;
  run: Run;
  onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const files = s.files.filter(
    (file) =>
      file.filename.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "all" ||
        (filter === "pending" && file.state !== "received") ||
        (filter === "received" && file.state === "received") ||
        (filter === "attention" &&
          ["retry", "attention", "missing"].includes(file.state))),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">RECORDING TRANSFERS</div>
          <h1>录音传输</h1>
          <p>本地副本保留，断线后继续传输。查询处理状态只发送文件标识。</p>
        </div>
        <div className="heading-actions">
          <button
            className="button secondary"
            onClick={() =>
              void run(() => bridge.refreshStatus(), "接收端状态已刷新")
            }
          >
            <RefreshCw size={15} />
            刷新状态
          </button>
          <button
            className={`button ${s.config.pauseUploads ? "primary" : "secondary"}`}
            onClick={() => void run(() => bridge.pause(!s.config.pauseUploads))}
          >
            {s.config.pauseUploads ? <Play size={15} /> : <Pause size={15} />}
            {s.config.pauseUploads ? "继续上传" : "暂停上传"}
          </button>
        </div>
      </div>
      {s.config.pauseUploads && (
        <div className="info-banner amber">
          <Pause size={18} />
          <div>
            <strong>上传已暂停</strong>
            <p>设备文件仍会保存到本机；继续上传后从接收端已确认的进度开始。</p>
          </div>
        </div>
      )}
      <section className="card transfers-card">
        <div className="transfer-toolbar">
          <div className="filter-tabs">
            {[
              ["all", "全部"],
              ["pending", "待传输"],
              ["received", "已入库"],
              ["attention", "需处理"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={filter === key ? "selected" : ""}
                onClick={() => setFilter(key)}
              >
                {label}
                {key === "all" && <span>{s.files.length}</span>}
              </button>
            ))}
          </div>
          <label className="search">
            <Search size={16} />
            <input
              aria-label="搜索录音文件"
              placeholder="搜索录音文件…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        <FileTable files={files} snapshot={s} run={run} onSelect={onSelect} />
        <div className="list-footer">
          <span>
            共 {files.length} 份录音 ·{" "}
            {size(files.reduce((n, f) => n + f.bytes, 0))}
          </span>
          <span>
            <ShieldCheck size={14} />
            接收回执确认后标记入库
          </span>
        </div>
      </section>
      <div className="status-legend">
        <span>
          <CheckCheck size={16} />
          已入库：原始文件已保存
        </span>
        <span>
          <ShieldCheck size={16} />
          复盘已保存：存在当前有效报告
        </span>
        <span>
          <CircleAlert size={16} />
          复盘待刷新：来源已更正
        </span>
      </div>
    </>
  );
}
function Settings({ snapshot: s, run }: { snapshot: Snapshot; run: Run }) {
  const [endpoint, setEndpoint] = useState(s.config.endpoint);
  const [workspaceId, setWorkspaceId] = useState(s.config.workspaceId);
  const [releaseRepo, setReleaseRepo] = useState(s.config.releaseRepo);
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [startAtLogin, setStartAtLogin] = useState(s.config.startAtLogin);
  const [saving, setSaving] = useState(false);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">CONNECTION & PREFERENCES</div>
          <h1>连接与设置</h1>
          <p>资料和队列保存在本机，爱马仕负责教学资料与处理结果。</p>
        </div>
      </div>
      <div className="settings-grid">
        <form
          className="card settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            setSaving(true);
            void run(async () => {
              await bridge.saveSettings({
                endpoint,
                workspaceId,
                releaseRepo,
                token,
                clearToken,
                startAtLogin,
              });
              setToken("");
              setClearToken(false);
            }, "设置已保存").finally(() => setSaving(false));
          }}
        >
          <div className="section-heading">
            <h3>
              <Cloud size={19} />
              爱马仕连接
            </h3>
            <span className="mini-label">RECEIVER</span>
          </div>
          <label className="field">
            接收端地址
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="http://内网地址:8766"
              type="url"
            />
            <small>使用同一教师资料空间的 HTTP 接收入口。</small>
          </label>
          <label className="field">
            教师空间 ID
            <input
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              required
            />
            <small>回执会校验此 ID，避免将录音传入其他资料空间。</small>
          </label>
          <label className="field">
            连接凭据
            {s.config.hasToken && (
              <span className="saved-token">已保存在系统凭据存储</span>
            )}
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              autoComplete="new-password"
              placeholder={
                s.config.hasToken
                  ? "留空保留已保存的凭据"
                  : "接收端未配置凭据时可留空"
              }
            />
            {s.config.hasToken && (
              <span className="checkbox">
                <input
                  type="checkbox"
                  checked={clearToken}
                  onChange={(e) => setClearToken(e.target.checked)}
                />
                清除已保存的连接凭据
              </span>
            )}
          </label>
          <div className="form-divider" />
          <div className="section-heading">
            <h3>
              <ArrowDownToLine size={19} />
              应用更新
            </h3>
          </div>
          <label className="field">
            公开 GitHub 更新仓库
            <input
              value={releaseRepo}
              onChange={(e) => setReleaseRepo(e.target.value)}
              placeholder="用户名/公开安装包仓库"
            />
            <small>自动检查并下载新版本，安装前由你确认。</small>
          </label>
          <div className="toggle-setting">
            <div>
              <strong>登录 Windows 时启动</strong>
              <p>在系统托盘运行，设备接入后自动处理。</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={startAtLogin}
              aria-label="登录 Windows 时启动"
              className={`toggle ${startAtLogin ? "on" : ""}`}
              onClick={() => setStartAtLogin(!startAtLogin)}
            >
              <span />
            </button>
          </div>
          <div className="form-bottom">
            <button className="button primary" type="submit" disabled={saving}>
              {saving ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Check size={15} />
              )}
              {saving ? "正在保存" : "保存设置"}
            </button>
            <button
              className="button secondary"
              type="button"
              onClick={() => void run(() => bridge.health())}
            >
              <Wifi size={15} />
              测试连接
            </button>
          </div>
        </form>
        <div className="settings-aside">
          <section className="card settings-update">
            <div className="section-heading">
              <h3>版本与更新</h3>
              <ArrowDownToLine size={18} />
            </div>
            <div className="version-value">
              {s.version}
              <span>当前版本</span>
            </div>
            <p>{s.update.detail}</p>
            {s.update.state === "downloading" && (
              <div className="progress">
                <i style={{ width: `${s.update.progress || 0}%` }} />
              </div>
            )}
            <button
              className={`button full ${s.update.state === "downloaded" ? "primary" : "secondary"}`}
              disabled={
                ["checking", "downloading"].includes(s.update.state) ||
                (s.update.state === "downloaded" && (s.scanning || !!s.copying))
              }
              onClick={() =>
                void run(() =>
                  s.update.state === "downloaded"
                    ? bridge.installUpdate()
                    : bridge.checkUpdates(),
                )
              }
            >
              {s.update.state === "downloaded"
                ? "安装更新并重启"
                : s.update.state === "checking"
                  ? "正在检查…"
                  : "检查更新"}
            </button>
            {s.update.state === "downloaded" && (
              <small>本地队列和连接设置会保留。</small>
            )}
          </section>
          <section className="card data-card">
            <div className="section-heading">
              <h3>本地资料</h3>
              <HardDrive size={18} />
            </div>
            <p>
              录音副本、传输队列和回执保存在安装目录之外。退出或更新后会继续。
            </p>
            <code>{s.dataDir}</code>
            <button
              className="text-button"
              onClick={() => void run(() => bridge.openDataDir())}
            >
              <FolderOpen size={15} />
              打开数据目录
              <ArrowRight size={14} />
            </button>
          </section>
          <div className="settings-note">
            <ShieldCheck size={21} />
            <strong>处理状态来自真实资料库</strong>
            <p>
              上传完成、转写保存和复盘保存各有独立状态。接收端暂时离线时会显示上次确认的结果。
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
function Details({
  file,
  snapshot,
  close,
  run,
}: {
  file: Recording;
  snapshot: Snapshot;
  close: () => void;
  run: Run;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [close]);
  return (
    <div className="drawer-backdrop" onClick={close}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="录音详情"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="section-heading">
          <h3>录音详情</h3>
          <button className="icon-button" aria-label="关闭详情" onClick={close}>
            <X size={19} />
          </button>
        </div>
        <div className="detail-icon">
          <FileAudio2 size={32} />
        </div>
        <h2>{file.filename}</h2>
        <Status file={file} />
        <dl>
          <dt>文件大小</dt>
          <dd>{size(file.bytes)}</dd>
          <dt>设备文件时间</dt>
          <dd>{dateTime(file.modifiedAt)}</dd>
          <dt>录音设备</dt>
          <dd>{file.sourceName}</dd>
          <dt>本地保存</dt>
          <dd>{dateTime(file.createdAt)}</dd>
          <dt>传输次数</dt>
          <dd>{file.attempts}</dd>
          <dt>最近状态确认</dt>
          <dd>
            {file.remoteCheckedAt ? dateTime(file.remoteCheckedAt) : "尚未查询"}
          </dd>
          <dt>内容标识 SHA-256</dt>
          <dd className="hash">{file.sha256}</dd>
        </dl>
        {file.receipt && (
          <div className="receipt-block">
            <ShieldCheck size={21} />
            <strong>爱马仕持久化回执</strong>
            <p>教师空间：{file.receipt.workspace_id}</p>
            <p>资产：{file.receipt.asset_id}</p>
            <p>接收时间：{dateTime(file.receipt.received_at)}</p>
          </div>
        )}
        {file.remote?.lesson_ids?.length ? (
          <div className="detail-lessons">
            <h3>关联课次</h3>
            {file.remote.lesson_ids.map((id) => (
              <span className="badge neutral" key={id}>
                {id}
              </span>
            ))}
          </div>
        ) : (
          file.state === "received" && (
            <div className="info-banner">
              <Clock3 size={18} />
              <p>在爱马仕中为录音关联课次，再进行转写和复盘。</p>
            </div>
          )
        )}
        {file.error && (
          <div className="info-banner amber">
            <CircleAlert size={18} />
            <p>{file.error}</p>
          </div>
        )}
        {snapshot.connection.state === "offline" &&
          file.state === "received" && (
            <p className="muted">接收端离线，以上处理结果为上次确认的状态。</p>
          )}
        {["retry", "attention"].includes(file.state) && (
          <button
            className="button primary full"
            onClick={() => void run(() => bridge.retry(file.id))}
          >
            <RefreshCw size={15} />
            重新尝试传输
          </button>
        )}
      </aside>
    </div>
  );
}
