const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { QueueDatabase, iso } = require("./database.cjs");
const { Importer } = require("./importer.cjs");
const {
  Transport,
  TransferError,
  normalizeEndpoint,
} = require("./transport.cjs");
const { windowsVolumes } = require("./volumes.cjs");
const { ChatTransport } = require("./chat.cjs");

class ClassroomClient extends EventEmitter {
  constructor(root, options = {}) {
    super();
    this.db = new QueueDatabase(root);
    this.version = options.version || "0.1.0";
    this.codec = options.codec;
    this.getVolumes = options.getVolumes || windowsVolumes;
    this.devices = [];
    this.volumes = [];
    this.timers = [];
    this.deviceBusy = false;
    this.deviceState = "checking";
    this.stopping = false;
    this.importer = new Importer(
      this.db,
      () => this.changed(),
      options.settleMs ?? 2000,
    );
    this.transport = new Transport(
      this.db,
      () => this.config(),
      () => this.token(),
      () => this.changed(),
      options.fetcher,
    );
    this.update = {
      state: "unconfigured",
      detail: "设置公开的 GitHub 更新仓库后启用自动更新",
    };
    this.chat = new ChatTransport(this.db, () => this.config(), () => this.token(),
      () => this.changed(), (view) => this.emit("chat", view), options.fetcher);
  }
  config() {
    return {
      endpoint: this.db.setting("endpoint", ""),
      workspaceId: this.db.setting("workspaceId", "teacher"),
      clientId: this.db.setting("clientId"),
      hasToken: !!this.db.setting("tokenEncrypted"),
      pauseUploads: this.db.setting("pauseUploads", false),
      startAtLogin: this.db.setting("startAtLogin", false),
      releaseRepo: this.db.setting("releaseRepo", ""),
      devices: this.db.setting("devices", []),
    };
  }
  token() {
    const stored = this.db.setting("tokenEncrypted");
    if (!stored) return "";
    try {
      if (!this.codec) throw new Error();
      return this.codec.decrypt(stored);
    } catch {
      throw new TransferError(
        "本机无法读取已保存的连接凭据，请重新填写",
        false,
      );
    }
  }
  saveSettings(input) {
    const old = this.config();
    const values = {};
    if (input.endpoint !== undefined)
      values.endpoint = normalizeEndpoint(input.endpoint.trim());
    if (input.workspaceId !== undefined) {
      if (!input.workspaceId.trim()) throw new Error("请填写教师空间 ID");
      values.workspaceId = input.workspaceId.trim();
    }
    if (input.releaseRepo !== undefined) {
      const repo = input.releaseRepo.trim();
      if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
        throw new Error("更新仓库格式为 GitHub 用户名/仓库名");
      values.releaseRepo = repo;
    }
    if (input.token !== undefined && input.token !== "") {
      if (!this.codec) throw new Error("系统凭据存储不可用，未保存凭据");
      values.tokenEncrypted = this.codec.encrypt(input.token);
    }
    if (input.clearToken) values.tokenEncrypted = null;
    if (input.startAtLogin !== undefined)
      values.startAtLogin = !!input.startAtLogin;
    const targetChanged =
      (values.endpoint !== undefined && values.endpoint !== old.endpoint) ||
      (values.workspaceId !== undefined &&
        values.workspaceId !== old.workspaceId);
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(values))
        this.db.setSetting(key, value);
      if (targetChanged) {
        this.db.db.exec(
          "UPDATE files SET state='queued', receipt=NULL, remote=NULL, remote_checked_at=NULL, uploaded_bytes=0, next_try=0 WHERE state='received'",
        );
      }
      this.db.log("连接设置已保存");
    });
    if (targetChanged) {
      this.chat.reset();
      this.transport.stop();
      this.transport.connection = {
        state: "unconfigured",
        detail: "连接设置已保存，等待检查",
        checkedAt: null,
      };
      this.transport.nextStatusAt = 0;
    }
    this.changed();
    if (this.config().endpoint) void this.chat.sync().catch(() => {});
    return this.config();
  }
  async bind(root, name) {
    root = path.resolve(root);
    if (!fs.statSync(root).isDirectory())
      throw new Error("请选择设备或录音所在的文件夹");
    const volumes = await this.getVolumes().catch(() => []);
    const volume = volumes.find((v) => {
      const relative = path.relative(v.root, root);
      return (
        relative !== ".." &&
        !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative)
      );
    });
    const bindings = this.config().devices;
    const duplicate = bindings.find(
      (d) =>
        d.originalRoot.toLowerCase() === root.toLowerCase() ||
        (volume &&
          d.volumeId === volume.volumeId &&
          d.relativeRoot === path.relative(volume.root, root)),
    );
    if (duplicate) return duplicate;
    const device = {
      id: crypto.randomUUID(),
      name: name || volume?.name || path.basename(root) || "录音设备",
      originalRoot: root,
      volumeId: volume?.volumeId || null,
      relativeRoot: volume ? path.relative(volume.root, root) : null,
    };
    bindings.push(device);
    this.db.setSetting("devices", bindings);
    this.db.log("已绑定设备目录：" + device.name);
    await this.refreshDevices();
    await this.scan();
    return device;
  }
  unbind(id) {
    if (this.importer.active?.deviceId === id)
      throw new Error("正在复制该设备，请等待复制结束");
    this.db.setSetting(
      "devices",
      this.config().devices.filter((d) => d.id !== id),
    );
    this.devices = this.devices.filter((d) => d.id !== id);
    this.db.log("已解除设备绑定，本地录音副本保留");
    this.changed();
  }
  async refreshDevices() {
    if (this.deviceBusy || this.stopping || this.importer.scanning) return;
    this.deviceBusy = true;
    try {
      this.volumes = await this.getVolumes();
      this.deviceState = "ready";
      const previous = new Map(this.devices.map((d) => [d.id, d]));
      this.devices = this.config().devices.map((binding) => {
        const volume = binding.volumeId
          ? this.volumes.find((v) => v.volumeId === binding.volumeId)
          : null;
        const root = volume
          ? path.join(volume.root, binding.relativeRoot || "")
          : binding.originalRoot;
        // A different volume reusing the old drive letter must not inherit this binding.
        const connected = binding.volumeId
          ? !!volume && fs.existsSync(root)
          : fs.existsSync(root);
        const old = previous.get(binding.id);
        return {
          ...binding,
          ...old,
          root,
          connected,
          lastSeenAt: connected ? iso() : old?.lastSeenAt || null,
          capacity: volume?.capacity,
          freeBytes: volume?.freeBytes,
          scanComplete: connected && !!old?.connected && !!old?.scanComplete,
        };
      });
    } catch {
      this.deviceState = "error";
      this.devices = this.devices.map((d) => ({
        ...d,
        connected: false,
        scanComplete: false,
        problem: "设备识别暂时不可用",
      }));
    } finally {
      this.deviceBusy = false;
      this.changed();
    }
  }
  async scan() {
    if (!this.stopping) await this.importer.scan(this.devices);
  }
  async addFiles(sources) {
    if (this.stopping) throw new Error("客户端正在退出，请重新添加文件");
    return this.importer.importFiles(sources);
  }
  createTask() {
    const task = {
      id: crypto.randomUUID(), title: "新任务", draft: "",
      createdAt: iso(), updatedAt: iso(),
    };
    this.db.setSetting("localTasks", [task, ...this.db.setting("localTasks", [])]);
    this.changed();
    return task;
  }
  async readChat(id) {
    const view = await this.chat.read(id);
    const tasks = this.db.setting("localTasks", []);
    const task = tasks.find((t) => t.id === id);
    if (task && view.connection === "online") {
      task.chatScope = this.chat.scope();
      this.db.setSetting("localTasks", tasks);
      this.changed();
    }
    return view;
  }
  saveTaskDraft({ id, draft }) {
    if (typeof draft !== "string") throw new Error("消息草稿无效");
    const tasks = this.db.setting("localTasks", []);
    let task = tasks.find((item) => item.id === id);
    if (!task) {
      const remote = this.chat.tasks().find((item) => item.id === id);
      if (!remote) throw new Error("任务不存在");
      task = { id, title: remote.title, draft: "", createdAt: remote.created_at, updatedAt: iso() };
      tasks.push(task);
    }
    task.draft = draft;
    if (!this.chat.tasks().find((t) => t.id === id))
      task.title = draft.trim().split(/\r?\n/)[0].slice(0, 36) || "新任务";
    task.updatedAt = iso();
    this.db.setSetting("localTasks", tasks);
    this.changed();
  }
  async start() {
    await this.importer.recover();
    await this.refreshDevices();
    await this.scan();
    this.timers.push(
      setInterval(() => {
        void this.refreshDevices().then(() => this.scan());
      }, 4000),
    );
    this.timers.push(
      setInterval(() => {
        void this.transport.tick();
      }, 1000),
    );
    this.timers.push(
      setInterval(() => {
        void this.transport.health();
      }, 120000),
    );
    if (this.config().endpoint) void this.transport.health();
    if (this.config().endpoint) void this.chat.sync().catch(() => {});
    this.timers.push(setInterval(() => {
      if (this.config().endpoint) void this.chat.sync().catch(() => {});
    }, 15000));
  }
  pause(paused) {
    this.db.setSetting("pauseUploads", !!paused);
    if (paused) this.transport.stop();
    this.changed();
  }
  snapshot() {
    const config = this.config();
    const local = this.db.setting("localTasks", []).filter((t) => !t.chatScope || t.chatScope === this.chat.scope());
    const remote = this.chat.tasks();
    const tasks = [...local.map((t) => ({ ...t, ...remote.find((r) => r.id === t.id), draft: t.draft })),
      ...remote.filter((r) => !local.some((t) => t.id === r.id)).map((r) => ({ ...r, draft: "", createdAt: r.created_at, updatedAt: r.updated_at }))];
    return {
      mode: "desktop",
      version: this.version,
      tasks,
      chatModels: this.chat.models.length ? this.chat.models : this.db.setting("chatModels:" + this.chat.scope(), []),
      deviceState: this.deviceState,
      config,
      dataDir: this.db.root,
      devices: this.devices.map((d) => ({
        ...d,
        safeToUnplug:
          d.connected &&
          d.scanComplete &&
          d.pending === 0 &&
          !d.problem &&
          this.importer.active?.deviceId !== d.id &&
          !this.importer.scanning,
      })),
      candidates: this.volumes.filter(
        (v) =>
          (v.removable || /dji|mic/i.test(v.name)) &&
          !config.devices.some((d) => d.volumeId === v.volumeId),
      ),
      files: this.db.all().map((f) => ({
        id: f.id,
        sha256: f.sha256,
        filename: f.filename,
        bytes: f.bytes,
        modifiedAt: f.modified_at,
        sourceName: f.source_name,
        createdAt: f.created_at,
        state: f.state,
        uploadedBytes: f.uploaded_bytes,
        attempts: f.attempts,
        error: f.error,
        nextTryAt: f.next_try,
        receipt: f.receipt ? JSON.parse(f.receipt) : null,
        remote: f.remote ? JSON.parse(f.remote) : null,
        remoteCheckedAt: f.remote_checked_at,
      })),
      copying: this.importer.active,
      scanning: this.importer.scanning,
      connection: this.transport.connection,
      update: this.update,
      logs: this.db.logs(),
    };
  }
  changed() {
    if (!this.stopping) this.emit("change", this.snapshot());
  }
  async close() {
    this.stopping = true;
    this.timers.forEach(clearInterval);
    this.importer.stop();
    this.transport.shutdown();
    await this.chat.close();
    // Let active I/O unwind before closing SQLite.
    while (
      this.importer.scanning ||
      this.importer.active ||
      this.transport.busy
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    this.db.close();
  }
}
module.exports = { ClassroomClient };
