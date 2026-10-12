const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { QueueDatabase } = require("../electron/core/database.cjs");
const { Importer } = require("../electron/core/importer.cjs");
const { ClassroomClient } = require("../electron/core/client.cjs");

async function fixture(t) {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), "fictional-classroom-import-"),
  );
  const source = path.join(root, "fictional-device");
  await fsp.mkdir(source);
  const db = new QueueDatabase(path.join(root, "client"));
  const databases = [db];
  t.after(async () => {
    for (const item of databases) {
      try {
        item.close();
      } catch {}
    }
    await fsp.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    source,
    db,
    databases,
    device: {
      id: "fictional-volume",
      name: "虚构录音设备",
      root: source,
      connected: true,
    },
  };
}

test("same content renamed deduplicates; same name with different content creates another recording", async (t) => {
  const { source, db, device } = await fixture(t);
  const importer = new Importer(db);
  const file = path.join(source, "fictional-time.wav");
  await fsp.writeFile(file, "FICTIONAL RECORDING A");
  await importer.copy(file, device, await fsp.stat(file));
  await fsp.rename(file, path.join(source, "fictional-renamed.wav"));
  const renamed = path.join(source, "fictional-renamed.wav");
  const duplicate = await importer.copy(
    renamed,
    device,
    await fsp.stat(renamed),
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(db.all().length, 1);
  await fsp.writeFile(renamed, "FICTIONAL RECORDING B (reused filename)");
  await importer.copy(renamed, device, await fsp.stat(renamed));
  assert.equal(db.all().length, 2);
  assert.equal(
    await fsp.readFile(renamed, "utf8"),
    "FICTIONAL RECORDING B (reused filename)",
  );
});

test("a source changing while copied is not registered or declared ready", async (t) => {
  const { source, db, device } = await fixture(t);
  const file = path.join(source, "fictional-growing.wav");
  await fsp.writeFile(file, Buffer.alloc(2 * 1024 * 1024, 97));
  let changed = false;
  const importer = new Importer(db, () => {
    if (importer.active?.copied && !changed) {
      changed = true;
      fs.appendFileSync(file, "FICTIONAL CHANGE");
    }
  });
  await assert.rejects(
    importer.copy(file, device, await fsp.stat(file)),
    /发生变化/,
  );
  assert.equal(db.all().length, 0);
  assert.deepEqual(await fsp.readdir(db.staging), []);
});

test("manual selection copies only selected files, deduplicates content, and keeps good files after a failure", async (t) => {
  const { source, db } = await fixture(t);
  const first = path.join(source, "fictional-selected.wav");
  const renamed = path.join(source, "fictional-duplicate.mp3");
  const last = path.join(source, "fictional-last.m4a");
  const ignored = path.join(source, "fictional-unselected.wav");
  await fsp.writeFile(first, "FICTIONAL MANUAL CONTENT A");
  await fsp.copyFile(first, renamed);
  await fsp.writeFile(last, "FICTIONAL MANUAL CONTENT B");
  await fsp.writeFile(ignored, "FICTIONAL FILE THAT MUST NOT BE IMPORTED");
  db.setSetting("pauseUploads", true);
  const importer = new Importer(db);
  const result = await importer.importFiles([
    first, renamed, path.join(source, "fictional-missing.wav"), last,
  ]);
  assert.equal(result.added, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].filename, "fictional-missing.wav");
  assert.equal(db.all().length, 2);
  assert.ok(db.all().every((row) => row.source_name === "手动上传"));
  assert.deepEqual(db.setting("devices", []), []);
  assert.equal(db.setting("pauseUploads"), true);
  assert.equal(await fsp.readFile(first, "utf8"), "FICTIONAL MANUAL CONTENT A");
  const duplicate = await importer.importFiles([last, first]);
  assert.equal(duplicate.added, 0);
  assert.equal(duplicate.duplicates, 2);
  await fsp.unlink(first);
  await fsp.unlink(last);
  assert.deepEqual(
    await Promise.all(db.all().map((row) => fsp.readFile(row.staged_path, "utf8"))),
    ["FICTIONAL MANUAL CONTENT B", "FICTIONAL MANUAL CONTENT A"],
  );
  assert.ok((await fsp.readdir(db.staging)).every((name) => !name.startsWith(".partial-")));
});

test("manual selection waits for automatic scanning rather than overlapping staging copies", async (t) => {
  const { root, source, db, device } = await fixture(t);
  const automatic = path.join(source, "fictional-automatic.wav");
  const manual = path.join(root, "fictional-manual.wav");
  await fsp.writeFile(automatic, Buffer.alloc(1024 * 1024, 65));
  await fsp.writeFile(manual, "FICTIONAL MANUAL COPY");
  const importer = new Importer(db, () => {}, 0);
  await importer.scan([device]);
  const copy = importer.copy.bind(importer);
  let active = 0, maximum = 0;
  t.mock.method(importer, "copy", async (...args) => {
    maximum = Math.max(maximum, ++active);
    try { return await copy(...args); }
    finally { active--; }
  });
  const scanning = importer.scan([device]);
  const selecting = importer.importFiles([manual]);
  const [, result] = await Promise.all([scanning, selecting]);
  assert.equal(result.added, 1);
  assert.equal(maximum, 1);
  assert.equal(db.all().length, 2);
  assert.equal(importer.active, null);
  assert.equal(importer.scanning, false);
});

test("scan waits for two stable observations and does not import a growing recording", async (t) => {
  const { source, db, device } = await fixture(t);
  const file = path.join(source, "fictional-stable.wav");
  await fsp.writeFile(file, "FICTIONAL DATA");
  await fsp.utimes(file, 1000, 1000);
  const importer = new Importer(db, () => {}, 15);
  await importer.scan([device]);
  assert.equal(db.all().length, 0);
  assert.equal(device.pending, 1);
  await new Promise((r) => setTimeout(r, 20));
  await importer.scan([device]);
  assert.equal(db.all().length, 1);
  assert.equal(device.pending, 0);
});

test("an unreadable child directory or disappearing file does not block other readable recordings", async (t) => {
  const { source, db, device } = await fixture(t);
  const blocked = path.join(source, "fictional-unreadable-child");
  await fsp.mkdir(blocked);
  const file = path.join(source, "fictional-readable.wav");
  await fsp.writeFile(file, "FICTIONAL READABLE DATA");
  const gone = path.join(source, "fictional-gone.wav");
  await fsp.writeFile(gone, "FICTIONAL GONE DATA");
  const originalRead = fsp.readdir,
    originalStat = fsp.stat;
  t.mock.method(fsp, "readdir", async (target, options) => {
    if (target === blocked)
      throw Object.assign(new Error("Fictional permission failure"), {
        code: "EACCES",
      });
    return originalRead(target, options);
  });
  t.mock.method(fsp, "stat", async (target, options) => {
    if (target === gone)
      throw Object.assign(new Error("Fictional overwritten file"), {
        code: "ENOENT",
      });
    return originalStat(target, options);
  });
  const importer = new Importer(db, () => {}, 0);
  await importer.scan([device]);
  await importer.scan([device]);
  assert.equal(db.all().length, 1);
  assert.equal(db.all()[0].filename, "fictional-readable.wav");
  assert.ok(device.problem);
  assert.equal(device.pending, 1);
});

test("restart keeps the queue, resets in-flight upload, removes only partial copies, and detects a missing staged file", async (t) => {
  const { root, source, db, device, databases } = await fixture(t);
  const file = path.join(source, "fictional-restart.wav");
  await fsp.writeFile(file, "FICTIONAL PERSISTENCE");
  await new Importer(db).copy(file, device, await fsp.stat(file));
  const row = db.all()[0];
  db.update(row.id, { state: "uploading", uploaded_bytes: 4 });
  await fsp.writeFile(
    path.join(db.staging, ".partial-fictional-crash"),
    "incomplete",
  );
  db.close();
  const recovered = new QueueDatabase(path.join(root, "client"));
  databases.push(recovered);
  await new Importer(recovered).recover();
  assert.equal(recovered.get(row.id).state, "queued");
  assert.equal(recovered.get(row.id).uploaded_bytes, 4);
  assert.ok(fs.existsSync(row.staged_path));
  assert.ok(!fs.existsSync(path.join(db.staging, ".partial-fictional-crash")));
  await fsp.unlink(row.staged_path);
  await new Importer(recovered).recover();
  assert.equal(recovered.get(row.id).state, "missing");
});

test("a different disk reusing a drive path is not treated as the bound recording device", async (t) => {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), "fictional-classroom-volume-"),
  );
  const source = path.join(root, "fictional-device");
  await fsp.mkdir(source);
  let volumes = [
    { volumeId: "volume-A", root: source + path.sep, name: "虚构设备 A" },
  ];
  const client = new ClassroomClient(path.join(root, "client"), {
    getVolumes: async () => volumes,
  });
  t.after(async () => {
    await client.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  await client.bind(source, "虚构设备 A");
  assert.equal(client.devices[0].connected, true);
  volumes = [
    { volumeId: "volume-B", root: source + path.sep, name: "虚构设备 B" },
  ];
  await client.refreshDevices();
  assert.equal(client.devices[0].connected, false);
  assert.equal(client.snapshot().devices[0].safeToUnplug, false);
});
