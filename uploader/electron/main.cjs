const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Tray,
  Menu,
  nativeImage,
  safeStorage,
  Notification,
  protocol,
  net,
} = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ClassroomClient } = require("./core/client.cjs");
const { Updates } = require("./core/updater.cjs");
const { autoUpdater } = require("electron-updater");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "classroom",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
let window, tray, client, updates;
let quitting = false,
  closing = false;
const devURL = !app.isPackaged ? process.env.CLASSROOM_DEV_URL : null;
const buildChannel = require("../package.json").classroomBuild?.channel || "release";
// Explicit profiles allow isolated acceptance without touching the teacher's default data.
const profileDirectory = app.commandLine.getSwitchValue("user-data-dir");
if (profileDirectory) app.setPath("userData", path.resolve(profileDirectory));
if (!app.isPackaged && process.env.CLASSROOM_TEST_DATA)
  app.setPath("userData", process.env.CLASSROOM_TEST_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => show());
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox("课堂连接无法启动", error.message);
      app.exit(1);
    });
}

const show = () => {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
};
function createWindow() {
  window = new BrowserWindow({
    icon: path.join(__dirname, "assets", "icon.png"),
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "课堂连接",
    backgroundColor: "#f7f8f5",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (
      devURL
        ? !url.startsWith(devURL + "/") && url !== devURL
        : !url.startsWith("classroom://app/")
    )
      event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.once("ready-to-show", () => {
    if (!process.argv.includes("--hidden")) window.show();
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  if (devURL) window.loadURL(devURL);
  else window.loadURL("classroom://app/index.html");
}
function handlers() {
  const handle = (name, fn) =>
    ipcMain.handle("client:" + name, async (event, input) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("无效客户端请求");
      return fn(input);
    });
  handle("snapshot", () => client.snapshot());
  handle("create-task", () => client.createTask());
  handle("task-draft", (input) => client.saveTaskDraft(input));
  handle("settings", async (input) => {
    const previousLogin = client.config().startAtLogin;
    client.transport.stop();
    while (client.transport.busy)
      await new Promise((resolve) => setTimeout(resolve, 25));
    const result = client.saveSettings(input);
    if (app.isPackaged && previousLogin !== result.startAtLogin)
      app.setLoginItemSettings({
        openAtLogin: result.startAtLogin,
        args: ["--hidden"],
      });
    updates.configure();
    void client.transport.health();
    void updates.check();
    return result;
  });
  handle("select-folder", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "选择录音设备或录音文件夹",
      properties: ["openDirectory"],
    });
    if (!result.canceled) await client.bind(result.filePaths[0]);
  });
  handle("select-files", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "选择要上传的音频文件",
      buttonLabel: "添加到上传队列",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "音频文件", extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "wma"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return client.addFiles(result.filePaths);
  });
  handle("bind-candidate", async (input) => {
    const volume = client.volumes.find((v) => v.volumeId === input.volumeId);
    if (!volume) throw new Error("设备已断开，请重新连接");
    return client.bind(volume.root, input.name || "DJI Mic Mini 2S");
  });
  handle("unbind", (id) => client.unbind(id));
  handle("scan", async () => {
    await client.refreshDevices();
    await client.scan();
  });
  handle("pause", (paused) => client.pause(paused));
  handle("retry", (id) => client.transport.retry(id));
  handle("health", () => client.transport.health());
  handle("results", (id) => client.transport.results(id));
  handle("status", async () => {
    await client.transport.health();
    if (client.transport.connection.state === "online")
      await client.transport.statuses();
  });
  handle("check-updates", () => updates.check());
  handle("install-update", () => updates.apply());
  handle("open-data", () => shell.openPath(client.db.root));
}
async function start() {
  protocol.handle("classroom", (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("", { status: 404 });
    const relative =
      decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const root = path.join(__dirname, "..", "dist");
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep))
      return new Response("", { status: 404 });
    return net.fetch(pathToFileURL(target).toString());
  });
  client = new ClassroomClient(app.getPath("userData"), {
    version: app.getVersion(),
    codec: {
      encrypt(value) {
        if (!safeStorage.isEncryptionAvailable())
          throw new Error("系统凭据存储不可用");
        return safeStorage.encryptString(value).toString("base64");
      },
      decrypt(value) {
        return safeStorage.decryptString(Buffer.from(value, "base64"));
      },
    },
  });
  const release = require("./release-config.json").repository;
  if (release && !client.config().releaseRepo)
    client.db.setSetting("releaseRepo", release);
  updates = new Updates(autoUpdater, client, {
    packaged: app.isPackaged,
    channel: buildChannel,
    notify(version) {
      if (Notification.isSupported())
        new Notification({
          title: "课堂连接有更新",
          body: `${version} 已下载，打开客户端即可安装。`,
        }).show();
    },
    install: async () => {
      quitting = true;
      closing = true;
      await client.close();
      autoUpdater.quitAndInstall(false, true);
    },
  });
  createWindow();
  handlers();
  client.on("change", (snapshot) => {
    if (window && !window.isDestroyed())
      window.webContents.send("client:changed", snapshot);
  });
  const icon = nativeImage
    .createFromPath(path.join(__dirname, "assets", "icon.png"))
    .resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip("课堂连接 · 本地复制与可靠传输");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开课堂连接", click: show },
      {
        label: "暂停 / 继续上传",
        click: () => client.pause(!client.config().pauseUploads),
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", show);
  await client.start();
  if (app.isPackaged && buildChannel !== "local") {
    setTimeout(() => void updates.check(), 10000);
    setInterval(() => void updates.check(), 6 * 60 * 60 * 1000).unref();
  }
}
app.on("before-quit", (event) => {
  quitting = true;
  if (client && !closing) {
    event.preventDefault();
    closing = true;
    void client.close().finally(() => {
      tray?.destroy();
      app.quit();
    });
  }
});
app.on("activate", show);
