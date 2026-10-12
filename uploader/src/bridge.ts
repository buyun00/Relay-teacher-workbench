import type { ChatView, ClientAPI, Recording, Snapshot } from "./types";

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
    chatModels: [
      { id: "deepseek-flash", label: "DeepSeek Flash", purpose: "日常沟通、资料整理" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", purpose: "写作与教学文字" },
      { id: "gpt-6-sol", label: "GPT-6 Sol", purpose: "制作功能与代码" },
      { id: "gpt-6-astra", label: "GPT-6 Astra", purpose: "数学推理与复杂备课" },
    ],
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
  const chatListeners = new Set<(view: ChatView) => void>();
  const chats = new Map<string, ChatView>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const chatEmit = (view: ChatView) => chatListeners.forEach((fn) => fn(structuredClone(view)));
  const chatView = (id: string): ChatView => {
    let view = chats.get(id);
    if (!view) {
      view = { chat: { id, title: "新任务", hermes_session_id: "fictional-" + id,
        native_tip: "fictional-" + id, route_state: "triage", model_id: null, route_reason: null },
        turns: [], events: [], cursor: 0, workspace_id: "fictional-demo", connection: "online" };
      chats.set(id, view);
    }
    return view;
  };
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
      if (!chats.get(id)?.turns.length) task.title = draft.trim().split(/\r?\n/)[0].slice(0, 36) || "新任务";
      task.updatedAt = new Date().toISOString();
      emit();
    },
    async readChat(id) { return structuredClone(chatView(id)); },
    async archiveTask({ id, archived }) {
      const task = state.tasks.find((t) => t.id === id);
      if (!task) throw new Error("对话不存在");
      task.archived_at = archived ? new Date().toISOString() : null;
      chatView(id).chat.archived_at = task.archived_at;
      chatEmit(chatView(id)); emit();
    },
    async openLink(url) { window.open(url, "_blank", "noopener,noreferrer"); },
    async copyText(value) { await navigator.clipboard.writeText(value); },
    subscribeChat(fn) { chatListeners.add(fn); return () => { chatListeners.delete(fn); }; },
    async selectChatModel({ id, modelId }) {
      const view = chatView(id);
      view.chat.model_id = modelId === "auto" ? null : modelId;
      view.chat.route_state = modelId === "auto" ? "triage" : "locked";
      view.chat.route_reason = modelId === "auto" ? "演示：DS 将了解需求" : "演示：你手动选择了模型";
      chatEmit(view);
      return structuredClone(view);
    },
    async cancelChat(id) {
      clearInterval(timers.get(id)); timers.delete(id);
      const view = chatView(id), turn = view.turns.at(-1);
      if (turn) turn.state = "cancelled";
      const task = state.tasks.find((t) => t.id === id); if (task) task.state = "cancelled";
      view.cursor++; chatEmit(view); emit();
    },
    async sendChat({ id, content }) {
      const view = chatView(id), task = state.tasks.find((t) => t.id === id);
      if (timers.has(id)) throw new Error("演示回复正在进行");
      const turn = { id: crypto.randomUUID(), chat_id: id, content, answer: "", state: "running" as const,
        model_id: view.chat.model_id || "deepseek-flash", error: null, created_at: new Date().toISOString() };
      view.turns.push(turn);
      if (task) { if (task.draft === content) task.draft = ""; task.state = "running"; }
      if (view.chat.route_state === "triage" && view.turns.length >= 2) {
        view.chat.model_id = "gpt-6-astra"; view.chat.route_state = "locked";
        view.chat.route_reason = "虚构分类：数学备课适合 GPT-6 Astra"; turn.model_id = "gpt-6-astra";
        view.chat.title = "对数函数教学备课"; view.chat.title_source = "ai";
        if (task) { task.title = view.chat.title; task.title_source = "ai"; }
      }
      const event = (kind: string, payload: ChatView["events"][number]["payload"]) => {
        view.events.push({ seq: ++view.cursor, chat_id: id, turn_id: turn.id, kind, payload, at: new Date().toISOString() });
      };
      const locked = view.chat.route_state === "locked";
      if (locked) event("tool_start", { id: "fictional-tool-" + turn.id, name: "teacher_context", args: { action: "overview" } });
      const answer = locked ? "这是**虚构的界面演示**，没有调用真实模型或保存教学结果。\n\n可以在这里流式阅读回复、展开执行步骤，并继续同一段对话。\n\n| 步骤 | 状态 |\n| --- | --- |\n| 了解需求 | 已演示 |\n| 读取资料 | 虚构结果 |"
        : "这是虚构回复，用于预览界面。你希望这次完成什么内容？可以告诉我课程主题和面向的年级。";
      view.cursor++; chatEmit(view); emit();
      let index = 0;
      const timer = setInterval(() => {
        index += 3; turn.answer = answer.slice(0, index); view.cursor++;
        if (index >= answer.length) {
          clearInterval(timer); timers.delete(id);
          (turn as ChatView["turns"][number]).state = "completed";
          if (locked) event("tool_end", { id: "fictional-tool-" + turn.id, name: "teacher_context", result: '{"fictional":true,"students":0}' });
          if (task) task.state = "completed";
        }
        chatEmit(view); emit();
      }, 45);
      timers.set(id, timer);
      return turn;
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
