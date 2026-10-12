import type { ClientAPI, Recording, Snapshot } from "./types";

function browserPreview(): ClientAPI {
  const date = "2026-10-12";
  const make = (
    n: number,
    state: Recording["state"],
    remote: Recording["remote"],
    hour: number,
  ): Recording => {
    const sha = String(n).padStart(64, "0");
    return {
      id: "demo_" + n,
      sha256: sha,
      filename: `虚构录音_${date.replaceAll("-", "")}_${hour}0000.wav`,
      bytes: 173000000 + n * 140000,
      modifiedAt: `${date}T${hour}:00:00+08:00`,
      sourceName: "DJI Mic Mini 2S",
      createdAt: `${date}T15:42:0${n}+08:00`,
      state,
      uploadedBytes:
        state === "received" ? 173000000 + n * 140000 : n === 4 ? 81000000 : 0,
      attempts: 1,
      error: state === "retry" ? "演示网络中断，本地副本已保留" : null,
      nextTryAt: 0,
      receipt:
        state === "received"
          ? {
              asset_id: `asset_demo_${n}`,
              received_at: `${date}T15:45:00+08:00`,
              workspace_id: "fictional-demo",
              upload_id: "up_" + sha,
              sha256: sha,
              byte_length: 173000000 + n * 140000,
            }
          : null,
      remote,
      remoteCheckedAt: state === "received" ? `${date}T15:46:00+08:00` : null,
    };
  };
  const state: Snapshot = {
    mode: "preview",
    version: "0.1.0",
    tasks: [],
    deviceState: "ready",
    dataDir: "浏览器预览 · 不保存真实录音",
    config: {
      endpoint: "",
      workspaceId: "fictional-demo",
      clientId: "browser-preview",
      hasToken: false,
      pauseUploads: false,
      startAtLogin: false,
      releaseRepo: "",
      devices: [],
    },
    devices: [
      {
        id: "demo_device",
        name: "DJI Mic Mini 2S",
        root: "E:\\",
        connected: true,
        safeToUnplug: true,
        fileCount: 6,
        pending: 0,
        capacity: 8000000000,
        freeBytes: 5320000000,
        lastScanAt: `${date}T15:44:00+08:00`,
      },
    ],
    candidates: [],
    files: [
      make(4, "uploading", null, 15),
      make(5, "queued", null, 14),
      make(
        1,
        "received",
        { state: "analyzed", workflow: { id: "fictional-workflow", state: "analyzed", complete: true,
          error: null, artifacts: [{ id: "fictional-brief", kind: "brief", title: "虚构复盘" },
          { id: "fictional-preparation", kind: "preparation", title: "虚构备课" }] } },
        10,
      ),
      make(2, "received", { state: "transcribing" }, 11),
      make(3, "received", { state: "awaiting_lesson" }, 13),
      make(6, "retry", null, 16),
    ],
    copying: null,
    scanning: false,
    connection: {
      state: "online",
      detail: "演示连接 · fictional-demo",
      checkedAt: `${date}T15:46:00+08:00`,
    },
    update: {
      state: "development",
      detail: "浏览器预览 · 安装包支持 GitHub 自动更新",
    },
    logs: [
      {
        id: 3,
        at: `${date}T15:45:00+08:00`,
        level: "info",
        message: "演示：接收端已保存一份录音",
      },
      {
        id: 2,
        at: `${date}T15:44:00+08:00`,
        level: "info",
        message: "演示：6 份录音的本地副本已就绪",
      },
      {
        id: 1,
        at: `${date}T15:42:00+08:00`,
        level: "info",
        message: "演示：已连接 DJI Mic Mini 2S",
      },
    ],
  };
  const listeners = new Set<(snapshot: Snapshot) => void>();
  let manualDemo = 100;
  const emit = () => listeners.forEach((fn) => fn(structuredClone(state)));
  const log = (message: string) => {
    state.logs.unshift({
      id: Date.now(),
      at: new Date().toISOString(),
      level: "info",
      message: "演示：" + message,
    });
    emit();
  };
  return {
    snapshot: async () => structuredClone(state),
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    async saveSettings(input) {
      const { token: _token, clearToken: _clear, ...settings } = input;
      Object.assign(state.config, settings);
      log("设置已应用于本次预览");
    },
    async selectFolder() {
      log("安装后的桌面端会打开文件夹选择器");
    },
    async selectFiles() {
      const n = manualDemo++;
      state.files.unshift({
        ...make(n, "queued", null, 17),
        filename: `虚构_手动上传_${n}.wav`,
        sourceName: "手动上传",
        createdAt: new Date().toISOString(),
      });
      log("手动添加了一份虚构音频；真实文件需在桌面端选择");
      return { added: 1, duplicates: 0, failed: [] };
    },
    async createTask() {
      const task = { id: crypto.randomUUID(), title: "新任务", draft: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.tasks.unshift(task);
      emit();
      return task;
    },
    async saveTaskDraft({ id, draft }) {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) throw new Error("任务不存在");
      task.draft = draft;
      task.title = draft.trim().split(/\r?\n/)[0].slice(0, 36) || "新任务";
      task.updatedAt = new Date().toISOString();
      emit();
    },
    async bindCandidate() {
      log("设备绑定");
    },
    async unbind(id) {
      state.devices = state.devices.filter((d) => d.id !== id);
      log("已解除设备绑定，示例队列保留");
    },
    async scan() {
      state.scanning = true;
      emit();
      setTimeout(() => {
        state.scanning = false;
        log("扫描完成，没有新的示例录音");
      }, 700);
    },
    async pause(paused) {
      state.config.pauseUploads = paused;
      const activeDemo = state.files.find((file) => file.id === "demo_4");
      if (activeDemo) activeDemo.state = paused ? "queued" : "uploading";
      log(paused ? "上传已暂停" : "上传已继续");
    },
    async retry(id) {
      const file = state.files.find((f) => f.id === id);
      if (file) {
        file.state = "queued";
        file.error = null;
      }
      log("已重新加入传输队列");
    },
    async health() {
      state.connection = {
        state: "online",
        detail: "演示连接 · fictional-demo",
        checkedAt: new Date().toISOString(),
      };
      log("演示连接正常");
    },
    async refreshStatus() {
      state.files.forEach((f) => {
        if (f.state === "received")
          f.remoteCheckedAt = new Date().toISOString();
      });
      log("示例状态已刷新");
    },
    async readResults() {
      return { state: "analyzed", complete: true, reports: [
        { id: "fictional-brief", kind: "brief", title: "虚构复盘示例", text: "这是一份明确虚构的课堂复盘，仅用于预览界面。\n00:00—00:10：示例课堂片段。", stale: 0, created_at: new Date().toISOString() },
        { id: "fictional-preparation", kind: "preparation", title: "虚构备课示例", text: "这是一份明确虚构的15分钟补充练习，仅用于预览界面。", stale: 0, created_at: new Date().toISOString() },
      ] };
    },
    async checkUpdates() {
      state.update = {
        state: "development",
        detail: "安装后的桌面端会检查公开 GitHub Releases",
      };
      emit();
    },
    async installUpdate() {
      log("浏览器预览不会安装更新");
    },
    async openDataDir() {
      log("浏览器预览没有本地数据目录");
    },
  };
}
export const bridge: ClientAPI = window.classroom ?? browserPreview();
