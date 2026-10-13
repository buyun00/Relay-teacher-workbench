const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { _electron: electron, expect } = require("@playwright/test");

async function checkTitleBar(app, page) {
  await expect(page.getByRole("banner", { name: "窗口标题栏" })).toContainText("课堂连接");
  assert.equal(await page.locator(".sidebar .app-name").count(), 0);
  const layout = await page.evaluate(() => {
    const overlay = navigator.windowControlsOverlay;
    const header = document.querySelector(".window-titlebar");
    const content = document.querySelector(".window-titlebar-content").getBoundingClientRect();
    return {
      visible: overlay?.visible, safe: overlay?.getTitlebarAreaRect().toJSON(),
      header: header.getBoundingClientRect().toJSON(), content: content.toJSON(),
      drag: getComputedStyle(header).getPropertyValue("app-region"),
      scrollHeight: document.documentElement.scrollHeight, viewport: innerHeight,
    };
  });
  assert.equal(layout.visible, true);
  assert.equal(layout.header.top, 0);
  assert.equal(layout.drag, "drag");
  assert.ok(layout.content.right <= layout.safe.right + 1);
  assert.ok(layout.content.left >= layout.safe.left - 1);
  assert.ok(Math.abs(layout.scrollHeight - layout.viewport) < 2);
}

async function checkNativeWindowActions(app) {
  // Exercise the actual Windows caption commands, including our close-to-tray handler.
  if (process.platform !== "win32") return;
  const handle = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString(),
  );
  const state = () => app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { maximized: win.isMaximized(), minimized: win.isMinimized(), hidden: !win.isVisible(), alive: !win.isDestroyed() };
  });
  for (const [message, command, key, value] of [[0xA3, 2, "maximized", true], [0xA3, 2, "maximized", false],
    [0x112, 0xF030, "maximized", true], [0x112, 0xF120, "maximized", false],
    [0x112, 0xF020, "minimized", true], [0x112, 0xF120, "minimized", false], [0x112, 0xF060, "hidden", true]]) {
    if (command === 0xF060) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
      assert.equal((await state()).hidden, false);
    }
    const child = spawn(process.env.CI ? "python" : "py", ["-c", [
      "import ctypes,sys",
      "from ctypes import wintypes",
      "u=ctypes.WinDLL('user32',use_last_error=True)",
      "u.PostMessageW.argtypes=[wintypes.HWND,wintypes.UINT,wintypes.WPARAM,wintypes.LPARAM]",
      "assert u.PostMessageW(int(sys.argv[1]),int(sys.argv[2]),int(sys.argv[3]),0),ctypes.get_last_error()",
    ].join("\n"), handle, String(message), String(command)], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", chunk => { errors += chunk; });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, errors);
    await expect.poll(async () => (await state())[key], { timeout: 5000 }).toBe(value);
  }
  assert.equal((await state()).alive, true);
}

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
    await checkTitleBar(app, window);
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
    const chatId = (await window.evaluate(() => window.classroom.snapshot())).tasks[0].id;
    const chatFile = path.join(root, "fictional-chat-reference.custom");
    const chatContent = Buffer.from("EXPLICITLY FICTIONAL CHAT REFERENCE 7319; NOT AUDIO");
    await fsp.writeFile(chatFile, chatContent);
    await app.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async (_window, options) => {
        if (!options.properties.includes("multiSelections") || options.filters) throw new Error("Chat accepts arbitrary multi-file attachments");
        return { canceled: false, filePaths: [filename] };
      };
    }, chatFile);
    await window.getByRole("button", { name: "添加附件", exact: true }).click();
    await expect(window.getByLabel("待发送附件").locator(".chat-attachment")).toHaveCount(1);
    const pastedPNG = await window.getByLabel("消息草稿").evaluate(el => {
      const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 160;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "#728c7a"; ctx.fillRect(0, 0, 320, 160);
      ctx.fillStyle = "white"; ctx.font = "22px sans-serif"; ctx.fillText("FICTIONAL IMAGE 9264", 20, 85);
      const data = canvas.toDataURL().split(",")[1];
      const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], "fictional-pasted.png", { type: "image/png" }));
      el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
      return data;
    });
    await expect(window.getByLabel("待发送附件").locator(".chat-attachment")).toHaveCount(2);
    await expect(window.getByLabel("待发送附件").getByRole("img")).toBeVisible();
    const chatAttachments = (await window.evaluate(() => window.classroom.snapshot())).tasks[0].attachments;
    await fsp.unlink(chatFile);
    assert.equal((await window.evaluate(() => window.classroom.snapshot())).files.length, 0);
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
    assert.deepEqual(state.tasks.find(t => t.id === chatId).attachments.map(a => a.id), chatAttachments.map(a => a.id));
    assert.equal(state.config.pauseUploads, true);
    assert.equal(state.config.hasToken, true);
    const storedBytes = await fsp.readFile(path.join(profile, "queue.sqlite"));
    assert.equal(storedBytes.includes(Buffer.from(token)), false);
    const turn = await window.evaluate(input => window.classroom.sendChat(input), { id: chatId, content: "", attachments: chatAttachments.map(a => a.id) });
    assert.deepEqual(turn.attachments.map(a => a.id), chatAttachments.map(a => a.id));
    assert.equal((await window.evaluate(() => window.classroom.snapshot())).tasks.find(t => t.id === chatId).attachments.length, 0);
    const view = await window.evaluate(id => window.classroom.readChat(id), chatId);
    assert.equal(view.turns.length, 1); assert.equal(view.chat.hermes_session_id, "teacher-desktop-" + chatId);
    for (const attachment of chatAttachments) {
      const original = path.join(root, "receiver", "originals", "chat-attachments", attachment.id, attachment.filename);
      const expected = attachment.mime === "image/png" ? Buffer.from(pastedPNG, "base64") : chatContent;
      assert.deepEqual(await fsp.readFile(original), expected);
    }
    await app.close(); app = null;
    // Remove just this isolated fixture's local image to exercise authenticated history download.
    const image = chatAttachments.find(a => a.mime === "image/png");
    await fsp.unlink(path.join(profile, "chat-attachments", image.id, image.filename));
    app = await launch(); window = await app.firstWindow();
    await window.waitForFunction(() => !!window.classroom && !!document.querySelector(".app-shell"));
    assert.ok(await window.evaluate(input => window.classroom.previewChatAttachment(input), { id: chatId, attachmentId: image.id }));
    assert.deepEqual(await fsp.readFile(path.join(profile, "chat-attachments", image.id, image.filename)), Buffer.from(pastedPNG, "base64"));
    if (localBuild) {
      assert.equal(state.update.state, "local");
      console.log("Local installer acceptance passed: explicit local version, updates disabled, retained queue and settings.");
    }
    await checkNativeWindowActions(app);
    console.log(
      `${packaged ? "Packaged EXE" : "Electron development"} acceptance passed: integrated native title bar and caption commands, close-to-tray, local UI protocol, sandbox, encrypted credentials, recording copy/receipt/restart, arbitrary chat file picker and pasted image IPC, source removal, attachment-only persisted turn, authenticated history image download.`,
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
