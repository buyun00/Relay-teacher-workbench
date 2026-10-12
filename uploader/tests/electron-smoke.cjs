const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { _electron: electron, expect } = require("@playwright/test");

async function startReceiver(root) {
  const command = process.env.CI
    ? "python"
    : process.platform === "win32"
      ? "py"
      : "python3";
  const child = spawn(
    command,
    [
      "-X",
      "utf8",
      "-m",
      "workbench.ingress",
      "--root",
      path.join(root, "receiver"),
      "--port",
      "0",
    ],
    {
      cwd: path.resolve(__dirname, "../.."),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HERMES_HOME: path.join(root, "fictional-hermes-home"),
        HERMES_UPLOADER_TOKEN: "FICTIONAL-ENCRYPTION-CHECK-ONLY",
      },
      windowsHide: true,
    },
  );
  const info = await new Promise((resolve, reject) => {
    let output = "",
      errors = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Fictional receiver startup timed out"));
    }, 10000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Receiver exited: " + errors));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(output.split("\n")[0]));
      }
    });
  });
  return { child, endpoint: "http://127.0.0.1:" + info.listen[1] };
}

(async () => {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), "fictional-classroom-electron-"),
  );
  const profile = path.join(root, "client");
  await fsp.mkdir(profile);
  const packaged = process.env.CLASSROOM_PACKAGED_EXE;
  const launch = () =>
    electron.launch({
      ...(packaged ? { executablePath: packaged } : {}),
      args: [
        ...(packaged ? [] : [path.resolve(__dirname, "..")]),
        "--hidden",
        "--user-data-dir=" + profile,
      ],
      env: { ...process.env, CLASSROOM_TEST_DATA: profile },
      timeout: 30000,
    });
  let app, receiver;
  try {
    receiver = await startReceiver(root);
    app = await launch();
    let window = await app.firstWindow();
    await window.waitForFunction(
      () => !!window.classroom && !!document.querySelector(".app-shell"),
    );
    let state = await window.evaluate(() => window.classroom.snapshot());
    const localBuild = await app.evaluate(({ app }) => {
      const requireApp = process.getBuiltinModule("module").createRequire(
        app.getAppPath() + "/electron/main.cjs",
      );
      const local = requireApp("../package.json").classroomBuild?.channel === "local";
      if (local) {
        globalThis.localUpdateChecks = 0;
        requireApp("electron-updater").autoUpdater.checkForUpdates = async () => {
          globalThis.localUpdateChecks++;
          throw new Error("A local installer must not request a GitHub update");
        };
      }
      return local;
    });
    if (localBuild) {
      assert.match(state.version, /-local\./);
      assert.equal(state.update.state, "local");
      await window.evaluate(() => window.classroom.checkUpdates());
    }
    assert.equal(state.mode, "desktop");
    assert.equal(state.files.length, 0);
    assert.equal(state.dataDir, profile);
    assert.equal(
      await window.evaluate(() => typeof window.require),
      "undefined",
    );
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
            .sandbox,
      ),
      true,
    );
    await window.getByRole("button", { name: "设置", exact: true }).click();
    if (localBuild) {
      await window.getByText("更多设置", { exact: true }).click();
      await expect(window.getByRole("button", { name: "本地包手动升级" })).toBeDisabled();
    }
    const token = "FICTIONAL-ENCRYPTION-CHECK-ONLY";
    await window.getByLabel("连接凭据", { exact: true }).fill(token);
    await window.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect
      .poll(
        () =>
          window
            .evaluate(() => window.classroom.snapshot())
            .then((s) => s.config.hasToken),
        { timeout: 10000 },
      )
      .toBe(true);
    state = await window.evaluate(() => window.classroom.snapshot());
    assert.equal(state.config.hasToken, true);
    assert.equal(JSON.stringify(state).includes(token), false);
    await window.getByRole("button", { name: "关闭设置", exact: true }).click();
    await window.getByRole("button", { name: "新建任务", exact: true }).click();
    const taskDraft = "EXPLICITLY FICTIONAL TASK DRAFT; NOT SENT TO A SERVICE";
    await window.getByRole("textbox", { name: "消息草稿" }).fill(taskDraft);
    await expect.poll(() => window.evaluate(() => window.classroom.snapshot()).then((s) => s.tasks[0]?.draft)).toBe(taskDraft);
    await window.evaluate(() => window.classroom.pause(true));

    const device = path.join(root, "fictional-device");
    await fsp.mkdir(device);
    const filename = path.join(device, "fictional-electron.wav");
    const content = Buffer.from(
      "EXPLICITLY FICTIONAL ELECTRON TRANSFER FIXTURE; NEVER SUBMITTED TO ASR",
    );
    await fsp.writeFile(filename, content);
    await fsp.utimes(filename, 1000, 1000);
    // Replace only the fixture's picker; actual preload IPC, volume resolution, copying and queue run unchanged.
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, device);
    await window.getByRole("button", { name: "录音上传", exact: true }).click();
    await window.getByRole("button", { name: "选择录音目录", exact: true }).click();
    await expect
      .poll(
        () =>
          window
            .evaluate(() => window.classroom.snapshot())
            .then((s) => s.files.length === 1 && s.devices[0]?.safeToUnplug),
        { timeout: 20000 },
      )
      .toBe(true);
    state = await window.evaluate(() => window.classroom.snapshot());
    assert.equal(state.files[0].state, "queued");
    assert.equal(
      state.files[0].sha256,
      crypto.createHash("sha256").update(content).digest("hex"),
    );
    const manualDirectory = path.join(root, "fictional-manual-selection");
    await fsp.mkdir(manualDirectory);
    const manualFilename = path.join(manualDirectory, "fictional-manual.m4a");
    const duplicateFilename = path.join(manualDirectory, "fictional-renamed.mp3");
    const manualContent = Buffer.from("EXPLICITLY FICTIONAL MANUAL UPLOAD; NEVER SUBMITTED TO ASR");
    await fsp.writeFile(manualFilename, manualContent);
    await fsp.writeFile(duplicateFilename, content);
    await fsp.writeFile(path.join(manualDirectory, "fictional-unselected.wav"), "FICTIONAL UNSELECTED FILE");
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    assert.equal(await window.evaluate(() => window.classroom.selectFiles()), null);
    assert.equal((await window.evaluate(() => window.classroom.snapshot())).files.length, 1);
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async (_window, options) => {
        if (!options.properties.includes("openFile") || !options.properties.includes("multiSelections"))
          throw new Error("Manual upload must use the native multi-file picker");
        return { canceled: false, filePaths: selected };
      };
    }, [manualFilename, duplicateFilename]);
    await window.getByRole("button", { name: "录音上传", exact: true }).click();
    await window.getByRole("button", { name: "手动上传", exact: true }).click();
    await expect(window.getByRole("status")).toContainText("新增 1 份录音；重复 1 份");
    state = await window.evaluate(() => window.classroom.snapshot());
    assert.equal(state.files.length, 2);
    assert.equal(state.config.devices.length, 1);
    assert.equal(state.files.find((file) => file.filename === "fictional-manual.m4a").sourceName, "手动上传");
    assert.equal(await fsp.readFile(manualFilename).then((bytes) => bytes.equals(manualContent)), true);
    await window.getByRole("button", { name: "手动上传", exact: true }).click();
    await expect(window.getByRole("status")).toContainText("新增 0 份录音；重复 2 份");
    assert.equal((await window.evaluate(() => window.classroom.snapshot())).files.length, 2);
    await fsp.rm(device, { recursive: true, force: true }); // Simulated unplug, before upload.
    await fsp.rm(manualDirectory, { recursive: true, force: true }); // All original files removed before upload.
    await window.evaluate(
      (endpoint) =>
        window.classroom.saveSettings({ endpoint, workspaceId: "teacher" }),
      receiver.endpoint,
    );
    await window.evaluate(() => window.classroom.pause(false));
    await expect
      .poll(
        () =>
          window
            .evaluate(() => window.classroom.snapshot())
            .then((s) => s.files.length === 2 && s.files.every((file) => file.state === "received")),
        { timeout: 20000 },
      )
      .toBe(true);
    await window.evaluate(() => window.classroom.refreshStatus());
    state = await window.evaluate(() => window.classroom.snapshot());
    for (const file of state.files) {
      assert.equal(file.remote.state, "awaiting_lesson");
      assert.equal(file.receipt.sha256, file.sha256);
      const extension = path.extname(file.filename);
      const serverOriginal = path.join(root, "receiver/originals", file.sha256, "original" + extension);
      const expected = file.sourceName === "手动上传" ? manualContent : content;
      assert.equal(await fsp.readFile(serverOriginal).then((bytes) => bytes.equals(expected)), true);
    }
    if (localBuild)
      assert.equal(await app.evaluate(() => globalThis.localUpdateChecks), 0);
    await window.evaluate(() => window.classroom.pause(true));
    await app.evaluate(({ app }) => app.quit());
    await app.close().catch(() => {});
    app = null;

    app = await launch();
    window = await app.firstWindow();
    await window.waitForFunction(
      () => !!window.classroom && !!document.querySelector(".app-shell"),
    );
    state = await window.evaluate(() => window.classroom.snapshot());
    assert.equal(state.files.length, 2);
    assert.ok(state.files.every((file) => file.state === "received"));
    assert.equal(state.tasks[0].draft, taskDraft);
    assert.equal(state.config.pauseUploads, true);
    assert.equal(state.config.hasToken, true);
    const storedBytes = await fsp.readFile(path.join(profile, "queue.sqlite"));
    assert.equal(storedBytes.includes(Buffer.from(token)), false);
    if (localBuild) {
      assert.equal(state.update.state, "local");
      console.log("Local installer acceptance passed: explicit local version, updates disabled, retained queue and settings.");
    }
    console.log(
      `${packaged ? "Packaged EXE" : "Electron development"} acceptance passed: local UI protocol, sandbox, encrypted credentials, device and multi-file manual copy, cancellation/deduplication, source removal before upload, persisted receiver receipt/status, restart preserves queue and pause.`,
    );
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.quit()).catch(() => {});
      await app.close().catch(() => {});
    }
    if (receiver?.child.exitCode === null) {
      receiver.child.kill();
      await once(receiver.child, "exit");
    }
    await fsp.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
