const fsp = require("node:fs/promises");
const { iso } = require("./database.cjs");

class TransferError extends Error {
  constructor(message, retryable = true) {
    super(message);
    this.retryable = retryable;
  }
}
const normalizeEndpoint = (value) => {
  if (!value) return "";
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("请输入 HTTP / HTTPS 接收端地址");
  return url.toString().replace(/\/+$/, "");
};

function verifyReceipt(receipt, file, workspaceId, uploadId) {
  if (
    !receipt ||
    receipt.sha256 !== file.sha256 ||
    receipt.byte_length !== file.bytes ||
    receipt.workspace_id !== workspaceId ||
    receipt.upload_id !== uploadId ||
    typeof receipt.asset_id !== "string" ||
    !receipt.asset_id.startsWith("asset_") ||
    typeof receipt.received_at !== "string" ||
    !Number.isFinite(Date.parse(receipt.received_at))
  ) {
    throw new TransferError("接收回执不匹配，文件已保留，请核查接收端", false);
  }
  return receipt;
}

class Transport {
  constructor(db, getConfig, getToken, onChange = () => {}, fetcher = fetch) {
    this.db = db;
    this.getConfig = getConfig;
    this.getToken = getToken;
    this.onChange = onChange;
    this.fetcher = fetcher;
    this.busy = false;
    this.controller = null;
    this.lifecycle = new AbortController();
    this.connection = {
      state: "unconfigured",
      checkedAt: null,
      detail: "填写爱马仕接收端地址后开始传输",
    };
    this.nextStatusAt = 0;
  }
  async request(route, options = {}, externalSignal = null) {
    const config = this.getConfig();
    if (!config.endpoint) throw new TransferError("尚未配置接收端", false);
    const token = this.getToken();
    const signal = AbortSignal.any([
      this.lifecycle.signal,
      ...(externalSignal ? [externalSignal] : []),
      AbortSignal.timeout(externalSignal ? 45000 : 15000),
    ]);
    const response = await this.fetcher(config.endpoint + route, {
      ...options,
      signal,
      redirect: "error",
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...options.headers,
      },
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new TransferError("接收端未返回有效 JSON");
    }
    if (!response.ok) {
      const retryable =
        response.status >= 500 || [408, 409, 429].includes(response.status);
      const messages = {
        401: "连接凭据无效，请检查设置",
        403: "接收端拒绝连接",
        404: "接收端地址或接口不存在",
        409: "接收端进度发生变化，将核对后续传",
      };
      throw new TransferError(
        messages[response.status] ||
          "接收端请求失败（" + response.status + "）",
        retryable,
      );
    }
    return body;
  }
  async health() {
    if (!this.getConfig().endpoint) return this.connection;
    this.connection = {
      state: "checking",
      checkedAt: this.connection.checkedAt,
      detail: "正在检查接收端",
    };
    this.onChange();
    try {
      const health = await this.request("/v1/health");
      if (
        health.protocol !== 1 ||
        health.workspace_id !== this.getConfig().workspaceId
      )
        throw new TransferError("接收端协议或教师空间不匹配", false);
      this.connection = {
        state: "online",
        checkedAt: iso(),
        detail: "已连接 · " + health.workspace_id,
      };
    } catch (error) {
      this.connection = {
        state: "offline",
        checkedAt: iso(),
        detail:
          error instanceof TransferError
            ? error.message
            : "接收端暂时不可达，已保存的录音会自动重试",
      };
    }
    this.onChange();
    return this.connection;
  }
  async transfer(file) {
    const config = this.getConfig();
    const controller = new AbortController();
    this.controller = controller;
    this.db.update(file.id, {
      state: "uploading",
      attempts: file.attempts + 1,
      error: null,
    });
    this.onChange();
    try {
      const opened = await this.request(
        "/v1/uploads",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sha256: file.sha256,
            byte_length: file.bytes,
            filename: file.filename,
            modified_at: file.modified_at,
            source_name: file.source_name,
            client_id: config.clientId,
            workspace_id: config.workspaceId,
          }),
        },
        controller.signal,
      );
      if (
        opened.workspace_id !== config.workspaceId ||
        typeof opened.upload_id !== "string" ||
        opened.upload_id !== "up_" + file.sha256
      )
        throw new TransferError("上传会话不匹配", false);
      let offset = opened.offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.bytes)
        throw new TransferError("接收端进度无效", false);
      this.db.update(file.id, {
        upload_id: opened.upload_id,
        uploaded_bytes: offset,
      });
      this.onChange();
      if (!opened.receipt) {
        const handle = await fsp.open(file.staged_path, "r");
        try {
          while (offset < file.bytes) {
            if (controller.signal.aborted)
              throw new DOMException("Paused", "AbortError");
            const buffer = Buffer.alloc(
              Math.min(4 * 1024 * 1024, file.bytes - offset),
            );
            const { bytesRead } = await handle.read(
              buffer,
              0,
              buffer.length,
              offset,
            );
            if (bytesRead !== buffer.length)
              throw new TransferError("本地副本不完整，请重新接入设备", false);
            const chunk = await this.request(
              `/v1/uploads/${opened.upload_id}?offset=${offset}`,
              {
                method: "PUT",
                headers: { "Content-Type": "application/octet-stream" },
                body: buffer,
              },
              controller.signal,
            );
            if (chunk.offset !== offset + bytesRead)
              throw new TransferError("接收端没有确认本段录音，稍后重新核对");
            offset = chunk.offset;
            this.db.update(file.id, { uploaded_bytes: offset });
            this.onChange();
          }
        } finally {
          await handle.close();
        }
      }
      const result = opened.receipt
        ? opened
        : await this.request(
            `/v1/uploads/${opened.upload_id}/complete`,
            { method: "POST" },
            controller.signal,
          );
      const receipt = verifyReceipt(
        result.receipt,
        file,
        config.workspaceId,
        opened.upload_id,
      );
      // Only a matching, persisted receipt can move an item to received.
      this.db.update(file.id, {
        state: "received",
        receipt: JSON.stringify(receipt),
        uploaded_bytes: file.bytes,
        endpoint: config.endpoint,
        workspace_id: config.workspaceId,
        error: null,
        next_try: 0,
      });
      this.db.log("爱马仕已保存：" + file.filename);
      this.connection = {
        state: "online",
        checkedAt: iso(),
        detail: "已连接 · " + config.workspaceId,
      };
      this.nextStatusAt = 0;
    } catch (error) {
      if (error.name === "AbortError" && controller.signal.aborted) {
        this.db.update(file.id, { state: "queued", error: null });
      } else {
        const retryable = !(error instanceof TransferError) || error.retryable;
        const attempts = this.db.get(file.id).attempts;
        const delay = Math.min(300000, 5000 * 2 ** Math.min(attempts - 1, 6));
        const message =
          error instanceof TransferError
            ? error.message
            : "网络连接中断，录音副本已保留";
        this.db.update(file.id, {
          state: retryable ? "retry" : "attention",
          error: message,
          next_try: Date.now() + delay,
        });
        this.connection = {
          state: "offline",
          checkedAt: iso(),
          detail: message,
        };
        this.db.log(file.filename + "：" + message, "warning");
      }
    } finally {
      this.controller = null;
      this.onChange();
    }
  }
  async statuses() {
    const config = this.getConfig();
    const files = this.db
      .all()
      .filter(
        (f) =>
          f.state === "received" &&
          f.endpoint === config.endpoint &&
          f.workspace_id === config.workspaceId,
      );
    if (!files.length) return;
    for (let i = 0; i < files.length; i += 100) {
      const batch = files.slice(i, i + 100);
      const result = await this.request("/v1/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: config.workspaceId,
          sha256: batch.map((f) => f.sha256),
        }),
      });
      if (
        result.workspace_id !== config.workspaceId ||
        !Array.isArray(result.items)
      )
        throw new TransferError("教师空间状态不匹配", false);
      const allowed = new Set([
        "received",
        "awaiting_lesson",
        "queued",
        "transcribing",
        "transcribed",
        "analyzing",
        "analyzed",
        "stale",
        "needs_attention",
        "unknown",
      ]);
      for (const file of batch) {
        const remote = result.items.find((item) => item.sha256 === file.sha256);
        const receipt = JSON.parse(file.receipt);
        if (
          remote &&
          allowed.has(remote.state) &&
          (remote.state === "unknown" || remote.asset_id === receipt.asset_id)
        ) {
          this.db.update(file.id, {
            remote: JSON.stringify(remote),
            remote_checked_at: iso(),
          });
        }
      }
    }
    this.connection = {
      state: "online",
      checkedAt: iso(),
      detail: "已连接 · " + config.workspaceId,
    };
    this.onChange();
  }
  async tick() {
    if (
      this.busy ||
      !this.getConfig().endpoint ||
      this.getConfig().pauseUploads
    )
      return;
    this.busy = true;
    try {
      const file = this.db.next();
      if (file) await this.transfer(file);
      else if (Date.now() >= this.nextStatusAt) {
        this.nextStatusAt = Date.now() + 60000;
        try {
          await this.statuses();
        } catch {
          this.connection = {
            state: "offline",
            checkedAt: iso(),
            detail: "状态刷新失败，显示上次确认的结果",
          };
          this.onChange();
        }
      }
    } finally {
      this.busy = false;
    }
  }
  retry(id) {
    const file = this.db.get(id);
    if (!file || !["retry", "attention", "queued"].includes(file.state)) return;
    this.db.update(id, { state: "queued", next_try: 0, error: null });
    this.onChange();
  }
  stop() {
    this.controller?.abort();
  }
  shutdown() {
    this.stop();
    this.lifecycle.abort();
  }
}
module.exports = { Transport, TransferError, verifyReceipt, normalizeEndpoint };
