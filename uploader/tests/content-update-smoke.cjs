const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { once } = require("node:events");
const { _electron: electron, expect } = require("@playwright/test");
const { buildContent } = require("../scripts/build-content.cjs");
const { sha256, MANIFEST_NAME } = require("../electron/shell/manifest.cjs");
const { QueueDatabase } = require("../electron/core/database.cjs");

(async () => {
  const executable = process.env.CLASSROOM_PACKAGED_EXE;
  assert.ok(executable && fs.existsSync(executable), "CLASSROOM_PACKAGED_EXE must point to the freshly built release-channel EXE");
  const source = path.resolve(__dirname, "..");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fictional-classroom-content-exe-"));
  const profile = path.join(root, "profile"), nextSource = path.join(root, "next-source"), output = path.join(root, "release");
  await fsp.mkdir(profile);
  for (const name of ["electron", "dist"]) await fsp.cp(path.join(source, name), path.join(nextSource, name), { recursive: true });
  await fsp.copyFile(path.join(source, "package.json"), path.join(nextSource, "package.json"));
  const initial = JSON.parse(await fsp.readFile(path.join(source, "runtime-manifest.json"), "utf8"));
  const version = initial.version.split(".").map(Number); version[2]++;
  const nextVersion = version.join(".");
  const repository = "fictional-owner/fictional-content-exe";
  const database = new QueueDatabase(profile);
  database.setSetting("releaseRepo", repository);
  database.db.close();
  const marker = "EXPLICITLY-FICTIONAL-CONTENT-UPDATE";
  await fsp.appendFile(path.join(nextSource, "electron/preload.cjs"), `\nrequire("electron").contextBridge.exposeInMainWorld("fictionalContentVersion", ${JSON.stringify(marker)});\n`);
  const clientFile = path.join(nextSource, "electron/core/client.cjs");
  await fsp.writeFile(clientFile, (await fsp.readFile(clientFile, "utf8")).replace("version: this.version,", `version: this.version, fictionalAcceptance: ${JSON.stringify(marker)},`));
  const htmlFile = path.join(nextSource, "dist/index.html");
  await fsp.writeFile(htmlFile, (await fsp.readFile(htmlFile, "utf8")).replace("<head>", `<head><meta name="fictional-content-update" content="${marker}">`));
  const manifest = await buildContent(nextSource, output, { version: nextVersion, repository, sourceSha: "b".repeat(40) });
  const requests = [], fullDownloads = [];
  const server = http.createServer(async (request, response) => {
    try {
      const name = path.posix.basename(new URL(request.url, "http://127.0.0.1").pathname);
      if (/\.exe$|\.blockmap$|latest\.yml$/.test(name)) { fullDownloads.push(name); throw new Error("Installer downloads are forbidden in this fixture"); }
      let bytes;
      if (name === "latest") bytes = Buffer.from(JSON.stringify({ tag_name: "v" + nextVersion, assets: [{ name: MANIFEST_NAME }] }));
      else if (name === MANIFEST_NAME) bytes = Buffer.from(JSON.stringify(manifest));
      else {
        assert.match(name, /^content-[a-f0-9]{64}\.br$/);
        requests.push(name);
        bytes = await fsp.readFile(path.join(output, "content", name));
      }
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length }); response.end(bytes);
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  const executableHash = sha256(await fsp.readFile(executable));
  let app;
  const launch = async () => {
    const instance = await electron.launch({ executablePath: executable, args: ["--hidden", "--user-data-dir=" + profile], timeout: 30000 });
    await instance.evaluate(({ net }, localOrigin) => {
      // Replace only the isolated fixture's network transport; updater, decompression, file store and IPC are real.
      globalThis.classroomRuntime.store.fetch = (url, options) => net.fetch(localOrigin + new URL(url).pathname, options);
    }, origin);
    return instance;
  };
  const pageFor = async instance => {
    const page = await instance.firstWindow();
    await page.waitForFunction(() => !!window.classroom && !!document.querySelector(".app-shell"));
    return page;
  };
  const quit = async () => {
    await app.evaluate(({ app }) => app.quit()); await app.close().catch(() => {}); app = null;
  };
  try {
    app = await launch(); let page = await pageFor(app);
    const base = await page.evaluate(() => window.classroom.snapshot());
    assert.equal(base.version, initial.version);
    const task = await page.evaluate(() => window.classroom.createTask());
    const draft = "EXPLICITLY FICTIONAL DRAFT RETAINED THROUGH CONTENT UPDATE";
    await page.evaluate(input => window.classroom.saveTaskDraft(input), { id: task.id, draft });
    await page.evaluate(() => window.classroom.pause(true));
    const audio = path.join(root, "EXPLICITLY-FICTIONAL-AUDIO.wav");
    await fsp.writeFile(audio, "EXPLICITLY FICTIONAL QUEUE CONTENT; NEVER SENT TO ASR");
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, audio);
    await page.evaluate(() => window.classroom.selectFiles());
    const before = await page.evaluate(() => window.classroom.snapshot());
    assert.equal(before.files.length, 1);
    // The startup scheduler must discover this release with no settings or manual check action.
    await expect.poll(() => page.evaluate(() => window.classroom.snapshot()).then(state => state.update.state), { timeout: 20000 }).toBe("downloaded");
    const banner = page.getByRole("region", { name: "客户端更新" });
    await expect(banner).toContainText(`新版本 ${nextVersion} 已下载`);
    await expect(banner.getByRole("button", { name: "重启并更新" })).toBeEnabled();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "录音上传", exact: true }).click();
    await expect(banner.getByRole("button", { name: "重启并更新" })).toBeVisible();
    const downloaded = await page.evaluate(() => window.classroom.snapshot());
    assert.equal(downloaded.version, initial.version);
    const changed = manifest.files.filter(file => !initial.files.some(old => old.sha256 === file.sha256));
    assert.equal(changed.length, 4);
    assert.deepEqual(requests.sort(), changed.map(file => file.asset).sort());
    assert.equal(downloaded.update.downloadedBytes, changed.reduce((sum, file) => sum + file.downloadSize, 0));
    assert.equal(fullDownloads.length, 0);
    // Exercise the visible restart button through real IPC and shutdown. Capture Electron's relaunch request
    // so the harness can own the next process instead of leaving an unattached EXE running after the test.
    const relaunchMarker = path.join(root, "fictional-relaunch.json");
    await app.evaluate(({ app }, markerPath) => {
      app.relaunch = () => require("node:fs").writeFileSync(markerPath, JSON.stringify({ requested: true, argv: process.argv }));
    }, relaunchMarker);
    const closed = app.waitForEvent("close", { timeout: 15000 });
    await banner.getByRole("button", { name: "重启并更新" }).click();
    await closed; app = null;
    const relaunch = JSON.parse(await fsp.readFile(relaunchMarker, "utf8"));
    assert.equal(relaunch.requested, true);
    assert.ok(relaunch.argv.includes("--user-data-dir=" + profile));
    app = await launch(); page = await pageFor(app);
    const after = await page.evaluate(() => window.classroom.snapshot());
    assert.equal(after.version, nextVersion);
    assert.equal(after.fictionalAcceptance, marker);
    assert.equal(await page.evaluate(() => window.fictionalContentVersion), marker);
    assert.equal(await page.locator('meta[name="fictional-content-update"]').getAttribute("content"), marker);
    assert.equal(after.files[0].id, before.files[0].id);
    assert.equal(after.files[0].sha256, before.files[0].sha256);
    assert.equal(after.files[0].state, "queued");
    assert.equal(after.tasks.find(item => item.id === task.id).draft, draft);
    assert.equal(after.config.pauseUploads, true);
    assert.equal(after.dataDir, profile);
    assert.equal(sha256(await fsp.readFile(executable)), executableHash);
    const statePath = path.join(profile, "business-updates/state.json");
    await expect.poll(async () => JSON.parse(await fsp.readFile(statePath, "utf8")).trial).toBe(null);
    const pointer = JSON.parse(await fsp.readFile(statePath, "utf8")); assert.ok(pointer.active);
    console.log(JSON.stringify({ acceptance: "packaged-content-update", from: initial.version, to: nextVersion,
      changed_files: changed.length, reused_files: manifest.files.length - changed.length, downloaded_bytes: downloaded.update.downloadedBytes,
      installer_requests: fullDownloads.length, executable_unchanged: true, retained: ["queue", "draft", "settings"],
      new_code_loaded: ["main services", "preload", "renderer"], automatic_detection: true, global_update_banner: true,
      restart_button_ipc: true, relaunch_requested: true, fictional_data_only: true }));
  } finally {
    if (app) { await app.evaluate(({ app }) => app.quit()).catch(() => {}); await app.close().catch(() => {}); }
    await new Promise(resolve => server.close(resolve));
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("fictional-classroom-content-exe-")) throw new Error("Invalid fixture cleanup");
    await fsp.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
