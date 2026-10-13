import { useState } from "react";
import { CircleAlert, Download, LoaderCircle, RefreshCw } from "lucide-react";
import { bridge } from "./bridge";
import type { Snapshot } from "./types";

export function UpdateBanner({ snapshot: s, run }: {
  snapshot: Snapshot;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [restarting, setRestarting] = useState(false);
  const update = s.update;
  const downloading = ["available", "downloading"].includes(update.state);
  const ready = update.readyVersion || (update.state === "downloaded" ? update.version : undefined);
  const failed = ["error", "incompatible"].includes(update.state);
  if (!downloading && !ready && !failed) return null;
  const blocked = s.copying || s.scanning ? "正在保存录音，完成后可重启" :
    s.tasks.some(task => ["queued", "running", "cancelling"].includes(task.state || "")) ? "正在回复，结束后可重启" : "";
  const version = downloading ? update.version : ready || update.version;
  const progress = Math.max(0, Math.min(100, Math.round(update.progress || 0)));
  const title = downloading ? `发现新版本${version ? " " + version : ""}，正在自动下载` :
    ready ? `新版本 ${ready} 已下载` : update.state === "incompatible" ? "有新版客户端可安装" : "自动更新暂时失败";
  const detail = downloading ? "下载完成后可重启更新" : ready ? blocked || "重启即可更新，也可在下次启动时自动更新" :
    update.state === "incompatible" ? "请下载安装新版客户端，安装后保留本地资料" : "请检查网络，可在这里重试；稍后也会自动重试";
  return (
    <section className={"update-banner " + (failed && !ready ? "update-banner-error" : "")}
      aria-label="客户端更新">
      {downloading ? <Download size={19} /> : ready ? <RefreshCw size={19} /> : <CircleAlert size={19} />}
      <div className="update-banner-text" role="status"><strong>{title}</strong><span>{detail}</span></div>
      {downloading ? <div className="update-banner-download">
        <LoaderCircle size={16} className="spin" />
        <span>{update.state === "available" ? "准备下载…" : progress + "%"}</span>
        {update.state === "downloading" && <progress aria-label="更新下载进度" value={progress} max={100} />}
      </div> : ready ? <button className="button primary" disabled={!!blocked || restarting}
        onClick={() => {
          setRestarting(true);
          void run(() => bridge.installUpdate()).finally(() => setRestarting(false));
        }}><RefreshCw size={15} />{restarting ? "正在重启…" : "重启并更新"}</button> :
        <button className="button secondary" onClick={() => void run(() => update.state === "incompatible"
          ? bridge.openLink(`https://github.com/${s.config.releaseRepo}/releases/latest`)
          : bridge.checkUpdates())}>{update.state === "incompatible" ? "下载新版客户端" : "重试更新"}</button>}
    </section>
  );
}
