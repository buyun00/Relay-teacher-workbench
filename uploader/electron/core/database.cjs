const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const iso = () => new Date().toISOString();

class QueueDatabase {
  constructor(root) {
    this.root = root;
    this.staging = path.join(root, "staging");
    fs.mkdirSync(this.staging, { recursive: true });
    this.db = new DatabaseSync(path.join(root, "queue.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version > 1) throw new Error("本地资料版本较新，请安装新版本客户端");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files(
        id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, filename TEXT NOT NULL,
        bytes INTEGER NOT NULL, staged_path TEXT NOT NULL, modified_at TEXT NOT NULL,
        source_name TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0,
        upload_id TEXT, uploaded_bytes INTEGER NOT NULL DEFAULT 0, receipt TEXT,
        remote TEXT, remote_checked_at TEXT, error TEXT, endpoint TEXT, workspace_id TEXT
      );
      CREATE TABLE IF NOT EXISTS sources(
        device_id TEXT NOT NULL, relative_path TEXT NOT NULL, bytes INTEGER NOT NULL,
        mtime_ms REAL NOT NULL, file_id TEXT NOT NULL REFERENCES files(id),
        PRIMARY KEY(device_id, relative_path)
      );
      CREATE TABLE IF NOT EXISTS activity(
        id INTEGER PRIMARY KEY, at TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL
      );
      PRAGMA user_version=1;
    `);
    // An interrupted transfer is resumed from the receiver's durable offset.
    this.db
      .prepare("UPDATE files SET state='queued' WHERE state='uploading'")
      .run();
    if (!this.setting("clientId"))
      this.setSetting("clientId", crypto.randomUUID());
  }
  setting(key, fallback = null) {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setSetting(key, value) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  knownSource(deviceId, relativePath, stat) {
    const row = this.db
      .prepare(
        `SELECT s.*, f.state, f.staged_path FROM sources s JOIN files f ON f.id=s.file_id
      WHERE device_id=? AND relative_path=?`,
      )
      .get(deviceId, relativePath);
    if (!row || row.bytes !== stat.size || row.mtime_ms !== stat.mtimeMs)
      return null;
    if (row.state !== "received" && !fs.existsSync(row.staged_path))
      return null;
    return row;
  }
  registerFile(file, source) {
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO files(id,sha256,filename,bytes,staged_path,modified_at,source_name,created_at)
        VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          file.id,
          file.sha256,
          file.filename,
          file.bytes,
          file.stagedPath,
          file.modifiedAt,
          source.name,
          iso(),
        );
      const stored = this.db
        .prepare("SELECT * FROM files WHERE sha256=?")
        .get(file.sha256);
      // Restore a missing unacknowledged staged copy without losing the queued identity.
      if (stored.state !== "received" && !fs.existsSync(stored.staged_path)) {
        this.db
          .prepare(
            "UPDATE files SET staged_path=?, state='queued', error=NULL WHERE id=?",
          )
          .run(file.stagedPath, stored.id);
      }
      this.db
        .prepare(
          `INSERT INTO sources VALUES(?,?,?,?,?) ON CONFLICT(device_id,relative_path)
        DO UPDATE SET bytes=excluded.bytes,mtime_ms=excluded.mtime_ms,file_id=excluded.file_id`,
        )
        .run(
          source.deviceId,
          source.relativePath,
          file.bytes,
          source.mtimeMs,
          stored.id,
        );
      return this.get(stored.id);
    });
  }
  get(id) {
    return this.db.prepare("SELECT * FROM files WHERE id=?").get(id);
  }
  all() {
    return this.db
      .prepare("SELECT * FROM files ORDER BY created_at DESC, rowid DESC")
      .all();
  }
  update(id, changes) {
    const allowed = new Set([
      "state",
      "attempts",
      "next_try",
      "upload_id",
      "uploaded_bytes",
      "receipt",
      "remote",
      "remote_checked_at",
      "error",
      "endpoint",
      "workspace_id",
    ]);
    const entries = Object.entries(changes);
    if (!entries.length || entries.some(([key]) => !allowed.has(key)))
      throw new Error("无效队列字段");
    this.db
      .prepare(
        `UPDATE files SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE id=?`,
      )
      .run(...entries.map(([, value]) => value), id);
  }
  next() {
    return this.db
      .prepare(
        "SELECT * FROM files WHERE state IN ('queued','retry') AND next_try<=? ORDER BY created_at, rowid LIMIT 1",
      )
      .get(Date.now());
  }
  log(message, level = "info") {
    this.db
      .prepare("INSERT INTO activity(at,level,message) VALUES(?,?,?)")
      .run(iso(), level, message);
    this.db.exec(
      "DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 120)",
    );
  }
  logs() {
    return this.db
      .prepare("SELECT * FROM activity ORDER BY id DESC LIMIT 20")
      .all();
  }
  close() {
    this.db.close();
  }
}
module.exports = { QueueDatabase, iso };
