const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const AUDIO = new Set([
  ".wav",
  ".mp3",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
  ".opus",
  ".wma",
]);
const sameStat = (a, b) =>
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs &&
  a.ino === b.ino;

async function walkAudio(root, problems = []) {
  const result = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === root) throw error;
      problems.push(directory);
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (
        entry.isFile() &&
        AUDIO.has(path.extname(entry.name).toLowerCase())
      )
        result.push(target);
    }
  };
  await visit(root);
  return result;
}

class Importer {
  constructor(db, onChange = () => {}, settleMs = 2000) {
    this.db = db;
    this.onChange = onChange;
    this.settleMs = settleMs;
    this.observations = new Map();
    this.active = null;
    this.scanning = false;
    this.controller = null;
    this.stopped = false;
  }
  async recover() {
    // Only incomplete copies in our own staging directory are disposable.
    for (const name of await fsp.readdir(this.db.staging)) {
      if (name.startsWith(".partial-"))
        await fsp.unlink(path.join(this.db.staging, name));
    }
    for (const row of this.db.all()) {
      if (row.state !== "received" && !fs.existsSync(row.staged_path)) {
        this.db.update(row.id, {
          state: "missing",
          error: "本地副本缺失，请重新接入录音设备",
        });
      }
    }
  }
  async copy(source, device, stat) {
    const partial = path.join(
      this.db.staging,
      ".partial-" + crypto.randomUUID(),
    );
    const hash = crypto.createHash("sha256");
    let copied = 0;
    let lastEmit = 0;
    this.controller = new AbortController();
    this.active = {
      filename: path.basename(source),
      bytes: stat.size,
      copied: 0,
      deviceId: device.id,
    };
    this.onChange();
    try {
      const before = await fsp.stat(source);
      if (!sameStat(before, stat))
        throw new Error("录音文件仍在变化，稍后重试");
      await pipeline(
        fs.createReadStream(source),
        new Transform({
          transform(chunk, _encoding, callback) {
            hash.update(chunk);
            copied += chunk.length;
            callback(null, chunk);
          },
        }).on("data", () => {
          this.active.copied = copied;
          if (Date.now() - lastEmit > 150) {
            lastEmit = Date.now();
            this.onChange();
          }
        }),
        fs.createWriteStream(partial, { flags: "wx" }),
        { signal: this.controller.signal },
      );
      const after = await fsp.stat(source);
      if (!sameStat(before, after) || copied !== before.size)
        throw new Error("录音在复制过程中发生变化，将重新读取");
      const handle = await fsp.open(partial, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      const sha256 = hash.digest("hex");
      const final = path.join(this.db.staging, sha256 + ".audio");
      const old = this.db.db
        .prepare("SELECT * FROM files WHERE sha256=?")
        .get(sha256);
      if (old && fs.existsSync(old.staged_path)) await fsp.unlink(partial);
      else {
        if (fs.existsSync(final)) await fsp.unlink(partial);
        else await fsp.rename(partial, final);
        if (process.platform !== "win32") {
          const directory = await fsp.open(this.db.staging, "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        }
      }
      const relativePath = path.relative(device.root, source);
      const row = this.db.registerFile(
        {
          id: "file_" + sha256,
          sha256,
          bytes: copied,
          filename: path.basename(source),
          stagedPath:
            old && fs.existsSync(old.staged_path) ? old.staged_path : final,
          modifiedAt: new Date(stat.mtimeMs).toISOString(),
        },
        {
          deviceId: device.id,
          relativePath,
          name: device.name,
          mtimeMs: stat.mtimeMs,
        },
      );
      this.db.log(
        old
          ? `已识别重复录音：${path.basename(source)}`
          : `本地副本已保存：${path.basename(source)}`,
      );
      return { row, duplicate: !!old };
    } finally {
      await fsp.unlink(partial).catch(() => {});
      this.active = null;
      this.controller = null;
      this.onChange();
    }
  }
  async scan(devices) {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    this.onChange();
    try {
      for (const device of devices) {
        device.scanComplete = false;
        device.pending = 0;
        device.problem = null;
        if (!device.connected) continue;
        try {
          const directoryProblems = [];
          const files = await walkAudio(device.root, directoryProblems);
          if (directoryProblems.length)
            device.problem = "有子目录无法读取，可读录音仍会保存";
          device.fileCount = files.length;
          for (const source of files) {
            if (this.stopped) break;
            let stat;
            try {
              stat = await fsp.stat(source);
            } catch {
              device.pending++;
              device.problem = "部分录音无法读取，请确认设备连接";
              continue;
            }
            const relative = path.relative(device.root, source);
            if (this.db.knownSource(device.id, relative, stat)) continue;
            const key = device.id + "\0" + relative;
            const old = this.observations.get(key);
            if (
              !stat.size ||
              !old ||
              !sameStat(old.stat, stat) ||
              Date.now() - old.at < this.settleMs ||
              Date.now() - stat.mtimeMs < this.settleMs
            ) {
              if (!old || !sameStat(old.stat, stat))
                this.observations.set(key, { stat, at: Date.now() });
              device.pending++;
              continue;
            }
            try {
              await this.copy(source, device, stat);
              this.observations.delete(key);
            } catch (error) {
              device.pending++;
              device.problem =
                error.name === "AbortError" ? "复制已暂停" : error.message;
            }
          }
          device.scanComplete = true;
          device.lastScanAt = new Date().toISOString();
        } catch {
          device.problem = "无法读取设备，请确认连接和盘符";
        }
        this.onChange();
      }
    } finally {
      this.scanning = false;
      this.onChange();
    }
  }
  stop() {
    this.stopped = true;
    this.controller?.abort();
  }
}
module.exports = { Importer, walkAudio, sameStat };
