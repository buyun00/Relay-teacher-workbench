const path = require("node:path");
const { compareVersions } = globalThis.classroomRuntime
  ? require(path.join(require("electron").app.getAppPath(), "electron/shell/manifest.cjs"))
  : require("../shell/manifest.cjs");

class Updates {
  constructor(store, client, options = {}) {
    this.store = store;
    this.client = client;
    this.packaged = options.packaged ?? false;
    this.localBuild = options.channel === "local";
    this.restart = options.restart || (() => { throw new Error("Desktop restart is not configured"); });
    this.notify = options.notify;
    this.busy = false;
    this.attempt = null;
    this.clock = options.clock || { now: Date.now, setTimeout, clearTimeout };
    this.timer = null;
    this.stopped = true;
    this.lastCheck = null;
    this.configure();
  }
  set(state) {
    this.client.update = { ...state, readyVersion: this.store.pending()?.manifest.version };
    this.client.changed();
  }
  preparedState(prepared, progress = {}) {
    return { state: "downloaded", version: prepared.manifest.version, progress: 100, ...progress,
      detail: "新内容已准备好，下次启动自动启用；也可立即重启启用" };
  }
  configure() {
    if (this.localBuild) {
      this.set({ state: "local", detail: "本地安装包，安装新生成的本地包即可升级" }); return false;
    }
    if (!this.packaged) {
      this.set({ state: "development", detail: "开发预览；正式版本只下载变化的业务内容" }); return false;
    }
    if (!this.client.config().releaseRepo) {
      this.set({ state: "unconfigured", detail: "填写公开 GitHub 更新仓库后启用自动内容更新" }); return false;
    }
    const prepared = this.store.pending();
    if (prepared) this.set(this.preparedState(prepared));
    return true;
  }
  cancel() { this.attempt?.abort(); }
  start() {
    if (!this.stopped || !this.configure()) return;
    this.stopped = false;
    this.schedule(10000);
  }
  schedule(delay) {
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.checkAutomatic(true);
    }, delay);
    this.timer?.unref?.();
  }
  stop() {
    this.stopped = true;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.cancel();
  }
  async checkAutomatic(force = false) {
    if (this.stopped || this.busy || (!force && this.lastCheck !== null && this.clock.now() - this.lastCheck < 60000)) return;
    await this.check();
  }
  async check() {
    if (this.busy || !this.configure()) return;
    this.busy = true;
    this.lastCheck = this.clock.now();
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    const attempt = this.attempt = new AbortController();
    const repository = this.client.config().releaseRepo;
    let version;
    this.set({ state: "checking", detail: "正在检查 GitHub 上的新内容" });
    try {
      const manifest = await this.store.latest(repository, AbortSignal.any([attempt.signal, AbortSignal.timeout(30000)]));
      if (repository !== this.client.config().releaseRepo) throw new Error("更新仓库已更改，请重新检查");
      const pending = this.store.pending();
      if (pending && compareVersions(manifest.version, pending.manifest.version) <= 0) {
        this.set(this.preparedState(pending)); return;
      }
      if (compareVersions(manifest.version, this.client.version) <= 0) {
        this.set({ state: "current", detail: "已是最新版本；更新只下载变化的业务内容" }); return;
      }
      version = manifest.version;
      this.set({ state: "available", version, detail: "发现新版本，正在准备自动下载" });
      let progress = {};
      const prepared = await this.store.prepare(manifest, { signal: attempt.signal, onProgress: value => {
        progress = value;
        this.set({ state: "downloading", version: manifest.version, ...value, detail: "正在下载变化的内容，未变文件从本地复用" });
      } });
      this.set(this.preparedState(prepared, progress));
      this.notify?.(manifest.version);
    } catch (error) {
      this.set({ state: error.code === "BASE_INCOMPATIBLE" ? "incompatible" : "error", version,
        detail: error.message || "内容更新失败，请检查 GitHub 网络连接后重试" });
    } finally {
      if (this.attempt === attempt) this.attempt = null;
      this.busy = false;
      this.schedule(this.client.update.state === "error" ? 5 * 60 * 1000 : 30 * 60 * 1000);
    }
  }
  async apply() {
    if (this.localBuild || !this.packaged || !this.store.pending()) throw new Error("业务更新尚未准备完成");
    if (this.client.importer.active || this.client.importer.scanning)
      throw new Error("正在读取设备，请等待本地复制结束再重启");
    if (this.client.sendingChats?.size || this.client.snapshot?.().tasks?.some(task => ["queued", "running", "cancelling"].includes(task.state)))
      throw new Error("对话正在执行，请等待当前回复结束后重启");
    await this.restart();
  }
}
module.exports = { Updates };
