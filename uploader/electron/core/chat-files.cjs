const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const mimeFor = (name, type) => type || ({
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif", heic: "image/heic", tiff: "image/tiff",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  wav: "audio/wav", mp3: "audio/mpeg", mp4: "video/mp4", zip: "application/zip",
}[path.extname(name).slice(1).toLowerCase()] || "application/octet-stream");

class ChatFiles {
  constructor(client) {
    this.client = client;
    this.db = client.db;
    this.operations = new Set();
    this.progress = new Map();
    this.controller = new AbortController();
    this.db.db.exec(`CREATE TABLE IF NOT EXISTS chat_files(
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL,
      bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL, draft INTEGER NOT NULL DEFAULT 1,
      scope TEXT, received_scope TEXT, created_at TEXT NOT NULL
    )`);
    for (const name of ["add", "upload", "ensure"]) {
      const method = this[name].bind(this);
      this[name] = (...args) => {
        const operation = Promise.resolve().then(() => method(...args));
        this.operations.add(operation);
        void operation.finally(() => this.operations.delete(operation)).catch(() => {});
        return operation;
      };
    }
  }
  row(id) { return this.db.db.prepare("SELECT * FROM chat_files WHERE id=?").get(id); }
  public(row) {
    return { id: row.id, filename: row.filename, mime: row.mime, bytes: row.bytes,
      ...(this.progress.get(row.id) || { status: "ready" }) };
  }
  drafts(chatId) { return this.db.db.prepare("SELECT * FROM chat_files WHERE chat_id=? AND draft=1 ORDER BY rowid").all(chatId).map(row => this.public(row)); }
  target(id, filename) { return path.join(this.db.root, "chat-attachments", id, filename); }
  validate(chatId) {
    const task = this.client.snapshot().tasks.find(t => t.id === chatId);
    if (!task) throw new Error("对话不存在于当前教师空间");
    if (task.archived_at) throw new Error("请先取消归档再添加附件");
    return task;
  }
  async add({ id: chatId, files }) {
    this.validate(chatId);
    if (!Array.isArray(files)) throw new Error("附件列表无效");
    const scope = this.client.chat.scope(), added = [], failed = [];
    for (const file of files) {
      const filename = path.basename(file.path || file.filename || "");
      if (!filename || [".", ".."].includes(filename)) throw new Error("附件文件名无效");
      const id = "att_" + crypto.randomUUID(), target = this.target(id, filename);
      const temporary = target + ".copying", digest = crypto.createHash("sha256");
      let bytes = 0;
      try {
        const data = file.path ? null : Buffer.from(file.data);
        const size = file.path ? (await fsp.stat(file.path)).size : data.length;
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await pipeline(file.path ? fs.createReadStream(file.path) : Readable.from([data]), new Transform({
          transform(chunk, _encoding, callback) { digest.update(chunk); bytes += chunk.length; callback(null, chunk); },
        }), fs.createWriteStream(temporary, { flags: "wx" }), { signal: this.controller.signal });
        if (bytes !== size) throw new Error("复制时文件发生变化，请重新添加");
        const out = await fsp.open(temporary, "r+");
        try { await out.sync(); } finally { await out.close(); }
        await fsp.rename(temporary, target);
        if (scope !== this.client.chat.scope()) throw new Error("教师空间已改变，请在当前对话重新添加附件");
        this.validate(chatId);
        this.db.db.prepare("INSERT INTO chat_files(id,chat_id,filename,mime,bytes,sha256,path,scope,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
          .run(id, chatId, filename, mimeFor(filename, file.mime), bytes, digest.digest("hex"), target,
            this.client.config().endpoint ? scope : null, new Date().toISOString());
        if (this.client.config().endpoint) {
          const tasks = this.db.setting("localTasks", []), task = tasks.find(t => t.id === chatId);
          if (task && !task.chatScope) { task.chatScope = scope; this.db.setSetting("localTasks", tasks); }
        }
        added.push(this.public(this.row(id)));
        this.client.changed();
      } catch (e) {
        await fsp.unlink(temporary).catch(() => {});
        if (!this.row(id)) await fsp.unlink(target).catch(() => {});
        failed.push(filename + "：" + (e.message || "复制失败"));
      }
    }
    if (failed.length) throw new Error("部分附件未添加：" + failed.join("；"));
    return added;
  }
  remove({ id: chatId, attachmentId }) {
    this.validate(chatId);
    this.db.db.prepare("UPDATE chat_files SET draft=0 WHERE chat_id=? AND id=?").run(chatId, attachmentId);
    // Copies are retained for message history and an uncertain acceptance receipt.
    this.client.changed();
  }
  async upload(chatId, ids, context) {
    for (const id of ids) {
      this.client.chat.assertScope(context);
      let row = this.row(id);
      if (!row) {
        const remote = await this.client.chat.request(`/v1/chats/${chatId}/attachments/${id}`, undefined, context);
        if (!remote.received_at) throw new Error("消息附件尚未接收");
        continue; // A retry of a historical attachment need not download or reupload it.
      }
      if (row.chat_id !== chatId || (row.scope && row.scope !== context.scope)) throw new Error("附件属于其他对话或教师空间");
      this.db.db.prepare("UPDATE chat_files SET scope=? WHERE id=?").run(context.scope, id);
      const route = `/v1/chats/${chatId}/attachments`;
      try {
        let receipt = row.received_scope === context.scope
          ? await this.client.chat.request(route + "/" + id, undefined, context)
          : await this.client.chat.request(route, { id, filename: row.filename, mime: row.mime,
            byte_length: row.bytes, sha256: row.sha256 }, context);
        const check = value => {
          if (value.id !== id || value.bytes !== row.bytes || value.workspace_id !== context.workspaceId || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > row.bytes) throw new Error("附件接收回执不匹配");
        };
        check(receipt);
        if (!receipt.received_at) {
          const input = await fsp.open(row.path, "r");
          try {
            while (receipt.offset < row.bytes) {
              this.client.chat.assertScope(context);
              const position = receipt.offset;
              const buffer = Buffer.alloc(Math.min(2 * 1024 * 1024, row.bytes - receipt.offset));
              const { bytesRead } = await input.read(buffer, 0, buffer.length, receipt.offset);
              if (!bytesRead) throw new Error("本地附件副本缺失，请重新添加");
              this.progress.set(id, { status: "uploading", uploadedBytes: receipt.offset }); this.client.changed();
              receipt = await this.client.chat.binary(route + "/" + id + "?offset=" + receipt.offset, "PUT", buffer.subarray(0, bytesRead), context);
              check(receipt);
              if (receipt.offset !== position + bytesRead) throw new Error("附件传输未推进，请重试");
            }
          } finally { await input.close(); }
          receipt = await this.client.chat.request(route + "/" + id + "/complete", {}, context);
        }
        if (receipt.id !== id || receipt.bytes !== row.bytes || !receipt.received_at) throw new Error("附件接收回执不匹配");
        this.db.db.prepare("UPDATE chat_files SET received_scope=? WHERE id=?").run(context.scope, id);
        this.progress.delete(id); this.client.changed();
      } catch (e) {
        this.progress.set(id, { status: "error", error: "附件上传未完成，副本已保留，点击发送重试" });
        this.client.changed(); throw e;
      }
    }
  }
  async ensure({ id: chatId, attachmentId }) {
    const row = this.row(attachmentId);
    if (row && (row.chat_id !== chatId || (row.scope && row.scope !== this.client.chat.scope()))) throw new Error("附件属于其他对话或教师空间");
    if (row && fs.existsSync(row.path)) return row;
    const context = this.client.chat.context();
    const route = `/v1/chats/${chatId}/attachments/${attachmentId}`;
    const remote = await this.client.chat.request(route, undefined, context);
    if (!remote.received_at) throw new Error("附件尚未传完");
    const response = await this.client.chat.fetchResponse(route + "/content", { method: "GET" }, context);
    const target = this.target(attachmentId, path.basename(remote.filename)), temporary = target + ".downloading-" + crypto.randomUUID();
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary), { signal: this.controller.signal });
      if ((await fsp.stat(temporary)).size !== remote.bytes) throw new Error("附件下载未完成，请重试");
      this.client.chat.assertScope(context);
      await fsp.rename(temporary, target);
      this.db.db.prepare("INSERT INTO chat_files(id,chat_id,filename,mime,bytes,sha256,path,draft,scope,received_scope,created_at) VALUES(?,?,?,?,?,'',?,0,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path")
        .run(attachmentId, chatId, remote.filename, remote.mime, remote.bytes, target, context.scope, context.scope, new Date().toISOString());
      return this.row(attachmentId);
    } finally { await fsp.unlink(temporary).catch(() => {}); }
  }
  async close() { this.controller.abort(); await Promise.allSettled([...this.operations]); }
}
module.exports = { ChatFiles };
