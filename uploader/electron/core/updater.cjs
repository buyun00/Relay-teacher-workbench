class Updates {
  constructor(updater, client, options = {}) {
    this.updater = updater;
    this.client = client;
    this.packaged = options.packaged ?? false;
    this.install =
      options.install || (() => updater.quitAndInstall(false, true));
    this.busy = false;
    updater.autoDownload = true;
    // Downloads are automatic; installation always follows the user's button click.
    updater.autoInstallOnAppQuit = false;
    if ("autoInstallEvent" in updater) updater.autoInstallEvent = "manual";
    updater.on("checking-for-update", () =>
      this.set({ state: "checking", detail: "正在检查 GitHub 上的新版本" }),
    );
    updater.on("update-available", (info) =>
      this.set({
        state: "downloading",
        version: info.version,
        progress: 0,
        detail: "发现新版本，正在下载",
      }),
    );
    updater.on("download-progress", (progress) =>
      this.set({
        ...client.update,
        state: "downloading",
        progress: progress.percent,
        detail: "正在下载更新包",
      }),
    );
    updater.on("update-not-available", () =>
      this.set({ state: "current", detail: "已是最新版本" }),
    );
    updater.on("update-downloaded", (info) => {
      this.set({
        state: "downloaded",
        version: info.version,
        progress: 100,
        detail: "更新已下载，点击安装并重启",
      });
      options.notify?.(info.version);
    });
    updater.on("error", () =>
      this.set({
        state: "error",
        detail: "更新检查失败，请确认公开仓库和网络连接",
      }),
    );
    this.configure();
  }
  set(state) {
    this.client.update = state;
    this.client.changed();
  }
  configure() {
    const repo = this.client.config().releaseRepo;
    if (!repo) {
      this.set({
        state: "unconfigured",
        detail: "填写公开 GitHub 更新仓库后启用自动更新",
      });
      return false;
    }
    if (!this.packaged) {
      this.set({
        state: "development",
        detail: "开发预览不安装更新；打包版本使用同一更新设置",
      });
      return false;
    }
    const [owner, name] = repo.split("/");
    this.updater.setFeedURL({
      provider: "github",
      owner,
      repo: name,
      releaseType: "release",
    });
    return true;
  }
  async check() {
    if (
      this.busy ||
      this.client.update.state === "downloaded" ||
      this.client.update.state === "downloading" ||
      !this.configure()
    )
      return;
    this.busy = true;
    try {
      await this.updater.checkForUpdates();
    } catch {
      this.set({ state: "error", detail: "更新检查失败，请稍后重试" });
    } finally {
      this.busy = false;
    }
  }
  async apply() {
    if (this.client.update.state !== "downloaded")
      throw new Error("更新包尚未下载完成");
    if (this.client.importer.active || this.client.importer.scanning)
      throw new Error("正在读取设备，请等待本地复制结束再安装更新");
    const previousPause = !!this.client.config().pauseUploads;
    this.client.pause(true);
    this.client.transport.stop();
    while (this.client.transport.busy)
      await new Promise((resolve) => setTimeout(resolve, 25));
    // Resume automatically in the new version, including any partially uploaded file.
    this.client.db.setSetting("pauseUploads", previousPause);
    await this.install();
  }
}
module.exports = { Updates };
