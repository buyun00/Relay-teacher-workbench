// Stable desktop base. All teacher-facing code is loaded from a complete business snapshot.
const { app, dialog, net } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { RuntimeStore } = require("./shell/store.cjs");
const { BUNDLED_MANIFEST, shellContract } = require("./shell/manifest.cjs");
const root = path.resolve(__dirname, "..");
const pkg = require("../package.json");
const channel = pkg.classroomBuild?.channel || "release";
const profile = app.commandLine.getSwitchValue("user-data-dir");
if (profile) app.setPath("userData", path.resolve(profile));
if (!app.isPackaged && process.env.CLASSROOM_TEST_DATA) app.setPath("userData", process.env.CLASSROOM_TEST_DATA);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, BUNDLED_MANIFEST), "utf8")); }
  catch (error) {
    if (app.isPackaged || error.code !== "ENOENT") throw error;
    manifest = { version: pkg.version, shell: shellContract(root), files: [] };
  }
  const store = new RuntimeStore(path.join(app.getPath("userData"), "business-updates"), root, manifest, { fetch: (...args) => net.fetch(...args) });
  let selected = store.bundled;
  if (app.isPackaged && channel !== "local") selected = store.selectForLaunch();
  store.current = selected;
  let watchdog;
  const context = globalThis.classroomRuntime = {
    store, channel, version: channel === "local" ? app.getVersion() : selected.manifest.version,
    root: selected.root,
    ready() { clearTimeout(watchdog); store.confirmLaunch(); },
    fail(error) {
      clearTimeout(watchdog);
      if (store.failLaunch(error.message || error)) {
        app.relaunch(); app.exit(1);
      } else {
        dialog.showErrorBox("课堂连接无法启动", error.message || String(error)); app.exit(1);
      }
    },
  };
  if (selected.id && store.state().trial === selected.id)
    watchdog = setTimeout(() => context.fail(new Error("新版本未能完成界面与队列初始化")), 30000);
  try { require(path.join(selected.root, "electron/main.cjs")); }
  catch (error) { context.fail(error); }
}
