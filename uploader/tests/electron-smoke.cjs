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
    await window.getByRole("button", { name: "连接与设置" }).click();
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
    await window.evaluate(() => window.classroom.selectFolder());
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
    await fsp.rm(device, { recursive: true, force: true }); // Simulated unplug, before upload.
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
            .then((s) => s.files[0]?.state),
        { timeout: 20000 },
      )
      .toBe("received");
    await window.evaluate(() => window.classroom.refreshStatus());
    state = await window.evaluate(() => window.classroom.snapshot());
    assert.equal(state.files[0].remote.state, "awaiting_lesson");
    assert.equal(state.files[0].receipt.sha256, state.files[0].sha256);
    const serverOriginal = path.join(
      root,
      "receiver/originals",
      state.files[0].sha256,
      "original.wav",
    );
    assert.equal(
      await fsp.readFile(serverOriginal).then((bytes) => bytes.equals(content)),
      true,
    );
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
    assert.equal(state.files.length, 1);
    assert.equal(state.files[0].state, "received");
    assert.equal(state.config.pauseUploads, true);
    assert.equal(state.config.hasToken, true);
    const storedBytes = await fsp.readFile(path.join(profile, "queue.sqlite"));
    assert.equal(storedBytes.includes(Buffer.from(token)), false);
    console.log(
      `${packaged ? "Packaged EXE" : "Electron development"} acceptance passed: local UI protocol, sandbox, encrypted credentials, real native bridge copy, unplug-before-upload, persisted receiver receipt/status, restart preserves queue and pause.`,
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
