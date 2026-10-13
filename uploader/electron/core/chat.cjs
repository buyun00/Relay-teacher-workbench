const crypto = require("node:crypto");

const delay = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
});

function applyEvent(view, event) {
  if (event.seq <= view.cursor) return false;
  if (event.chat_id !== view.chat.id) throw new Error("对话事件不匹配");
  const { kind, payload: p, turn_id: id } = event;
  let turn = view.turns.find((t) => t.id === id);
  if (kind === "turn" && !turn) {
    turn = { ...p, chat_id: view.chat.id, error: null };
    view.turns.push(turn);
    if (view.turns.length === 1) view.chat.title = (p.content.trim().split(/\r?\n/)[0] || p.attachments?.[0]?.filename || "新任务").slice(0, 36);
  }
  if (kind === "delta" && turn) turn.answer += p.text;
  if (["state", "done", "model"].includes(kind) && turn) Object.assign(turn, p);
  if (["route", "metadata"].includes(kind)) Object.assign(view.chat, p);
  if (["tool_start", "tool_end", "status", "route", "notice", "commentary"].includes(kind)) view.events.push(event);
  view.cursor = event.seq;
  view.chat.updated_at = event.at;
  return true;
}

class ChatTransport {
  constructor(db, getConfig, getToken, onChange, onView, fetcher = fetch) {
    Object.assign(this, { db, getConfig, getToken, onChange, onView, fetcher });
    this.views = new Map();
    this.models = [];
    this.controller = null;
    this.watching = null;
    this.loops = new Set();
    this.lifecycle = new AbortController();
    this.syncing = null;
    this.operations = new Set();
    for (const name of ["read", "send", "model", "cancel", "sync", "archive"]) {
      const method = this[name].bind(this);
      this[name] = (...args) => {
        const operation = Promise.resolve().then(() => method(...args));
        this.operations.add(operation);
        void operation.finally(() => this.operations.delete(operation)).catch(() => {});
        return operation;
      };
    }
  }
  scope() { const c = this.getConfig(); return c.endpoint + "|" + c.workspaceId; }
  tasks() { return this.db.setting("chatTasks:" + this.scope(), []); }
  context() { return { ...this.getConfig(), scope: this.scope(), token: this.getToken() }; }
  assertScope(context) { if (context.scope !== this.scope()) throw new Error("连接空间已改变，请重新打开对话"); }
  async fetchResponse(route, options, c = this.context()) {
    if (!c.endpoint) throw new Error("请在设置中填写连接地址后开始对话");
    const response = await this.fetcher(c.endpoint + route, {
      ...options, redirect: "error", signal: AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(60000)]),
      headers: { ...options.headers, ...(c.token ? { Authorization: "Bearer " + c.token } : {}) },
    });
    if (!response.ok) {
      const value = await response.json();
      const error = new Error(response.status === 401 ? "连接凭据无效，请检查设置" : value.error || "对话服务连接失败");
      error.status = response.status;
      throw error;
    }
    return response;
  }
  async request(route, body, c = this.context()) {
    const response = await this.fetchResponse(route, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify({ ...body, workspace_id: c.workspaceId }) }),
    }, c);
    const value = await response.json();
    if (value.workspace_id && value.workspace_id !== c.workspaceId) throw new Error("对话服务与教师空间不匹配");
    return value;
  }
  async binary(route, method, body, c) {
    const response = await this.fetchResponse(route, { method, body, headers: { "Content-Type": "application/octet-stream" } }, c);
    const value = await response.json();
    if (value.workspace_id !== c.workspaceId) throw new Error("附件与教师空间不匹配");
    return value;
  }
  sync() {
    if (this.syncing) return this.syncing;
    const scope = this.scope();
    this.syncing = Promise.all([this.request("/v1/chats"), this.request("/v1/chat-models")]).then(([data, catalog]) => {
      if (scope !== this.scope()) return;
      this.db.setSetting("chatTasks:" + scope, data.chats);
      this.models = catalog.models;
      this.db.setSetting("chatModels:" + scope, this.models);
      this.onChange();
    }).finally(() => { this.syncing = null; });
    return this.syncing;
  }
  cached(id) { return this.views.get(id) || this.db.setting("chatView:" + this.scope() + ":" + id); }
  save(view, scope = this.scope()) {
    if (scope !== this.scope()) return;
    this.views.set(view.chat.id, view);
    this.db.setSetting("chatView:" + scope + ":" + view.chat.id, view);
    const tasks = this.tasks();
    const turn = view.turns.at(-1);
    const summary = { ...view.chat, state: turn?.state || null };
    const i = tasks.findIndex((t) => t.id === view.chat.id);
    if (i < 0) tasks.unshift(summary); else tasks[i] = summary;
    this.db.setSetting("chatTasks:" + scope, tasks);
    this.onView(structuredClone(view));
    this.onChange();
  }
  async read(id) {
    this.detach();
    const controller = new AbortController();
    this.controller = controller;
    this.watching = id;
    const scope = this.scope();
    let view;
    try {
      await this.request("/v1/chats", { id });
      view = await this.request("/v1/chats/" + id);
      view.connection = "online";
      view.connectionError = null;
      if (scope === this.scope()) this.save(view, scope);
    } catch (error) {
      view = this.cached(id);
      if (!view) throw error;
      view = structuredClone(view);
      view.connection = "offline";
      view.connectionError = "连接中断，显示已保存的对话，正在重连…";
      this.save(view, scope);
    }
    if (!controller.signal.aborted && scope === this.scope()) {
      const loop = this.stream(id, view, scope, controller.signal);
      this.loops.add(loop);
      void loop.finally(() => this.loops.delete(loop));
    }
    return view;
  }
  async stream(id, view, scope, signal) {
    while (!signal.aborted && !this.lifecycle.signal.aborted) {
      try {
        const c = this.getConfig();
        const token = this.getToken();
        const response = await this.fetcher(c.endpoint + "/v1/chats/" + id + "/events?after=" + view.cursor, {
          redirect: "error", headers: token ? { Authorization: "Bearer " + token } : {},
          signal: AbortSignal.any([signal, this.lifecycle.signal, AbortSignal.timeout(55000)]),
        });
        if ([401, 403].includes(response.status)) {
          view.connection = "offline";
          view.connectionError = "对话连接凭据无效，请检查设置后重新打开对话";
          this.save(view, scope);
          return;
        }
        if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("流式连接不可用");
        view.connection = "online";
        view.connectionError = null;
        this.save(view, scope);
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
              if (data && applyEvent(view, JSON.parse(data))) this.save(view, scope);
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
      } catch {
        if (signal.aborted || this.lifecycle.signal.aborted) break;
        view.connection = "offline";
        view.connectionError = "连接中断，已保存内容，正在重连…";
        this.save(view, scope);
        await delay(2000, signal);
      }
    }
  }
  async send({ id, content, attachments = [] }, upload = async () => {}) {
    const context = this.context();
    const key = "chatPending:" + context.scope + ":" + id;
    let pending = this.db.setting(key);
    if (pending && (pending.content !== content || JSON.stringify(pending.attachments || []) !== JSON.stringify(attachments))) {
      if (pending.phase !== "uploading") {
        const view = await this.request("/v1/chats/" + id, undefined, context);
        if (!view.turns.some((t) => t.id === pending.id)) throw new Error("上一条消息的发送状态待确认，请先重试原消息");
      }
      this.db.setSetting(key, null);
      pending = null;
    }
    pending ||= { id: crypto.randomUUID(), content, attachments, phase: "uploading" };
    this.db.setSetting(key, pending);
    await this.request("/v1/chats", { id }, context);
    try {
      this.assertScope(context);
      await upload(id, attachments, context);
      this.assertScope(context);
      pending.phase = "accepting"; this.db.setSetting(key, pending);
      const turn = await this.request("/v1/chats/" + id + "/turns", pending, context);
      this.db.setSetting(key, null);
      return turn;
    } catch (error) {
      if (error.status && error.status < 500) this.db.setSetting(key, null);
      throw error;
    }
  }
  async model({ id, modelId }) {
    await this.request("/v1/chats", { id });
    await this.request("/v1/chats/" + id + "/model", { model_id: modelId });
    return this.read(id);
  }
  async cancel(id) { return this.request("/v1/chats/" + id + "/cancel", {}); }
  async archive({ id, archived }) {
    const scope = this.scope();
    await this.request("/v1/chats", { id });
    if (scope !== this.scope()) throw new Error("连接空间已改变，请重新打开对话");
    const view = await this.request("/v1/chats/" + id + "/archive", { archived });
    if (scope !== this.scope()) throw new Error("连接空间已改变，归档状态会在原空间同步");
    view.connection = "online";
    this.save(view, scope);
    return view;
  }
  detach() { this.controller?.abort(); this.controller = null; this.watching = null; }
  reset() { this.detach(); this.views.clear(); this.models = []; }
  async close() { this.detach(); this.lifecycle.abort(); await Promise.allSettled([...this.operations, ...this.loops, this.syncing].filter(Boolean)); }
}
module.exports = { ChatTransport, applyEvent };
