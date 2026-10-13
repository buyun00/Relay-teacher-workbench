const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const { MANIFEST_NAME, sha256, compareVersions, validateManifest } = require("./manifest.cjs");
const decompress = promisify(zlib.brotliDecompress);

function writeJSON(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = filename + "." + crypto.randomUUID() + ".tmp";
  const fd = fs.openSync(temporary, "wx");
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
}
class RuntimeStore {
  constructor(root, bundledRoot, bundledManifest, options = {}) {
    this.root = path.resolve(root);
    this.bundled = { root: bundledRoot, manifest: bundledManifest, id: null };
    this.shell = bundledManifest.shell;
    this.fetch = options.fetch || globalThis.fetch;
    this.downloadIdleMs = options.downloadIdleMs ?? 120000;
    this.statePath = path.join(this.root, "state.json");
    this.current = this.bundled;
  }
  state() {
    const empty = { active: null, previous: null, pending: null, trial: null, rejected: [] };
    try {
      const saved = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new SyntaxError("Invalid update state");
      return { ...empty, ...saved, rejected: Array.isArray(saved.rejected) ? saved.rejected : [] };
    } catch (error) {
      if (error.code === "ENOENT") return empty;
      if (!(error instanceof SyntaxError)) throw error;
      fs.renameSync(this.statePath, this.statePath + ".invalid." + crypto.randomUUID());
      return { ...empty, lastFailure: "更新状态损坏，已恢复安装时的版本；原状态保留用于排查" };
    }
  }
  save(state) { writeJSON(this.statePath, state); }
  descriptor(id) {
    if (!id) return this.bundled;
    if (!/^\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(id)) throw new Error("Invalid prepared runtime reference");
    const root = path.join(this.root, "versions", id);
    const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(root, MANIFEST_NAME), "utf8")), this.shell);
    if (this.identifier(manifest) !== id) throw new Error("Prepared runtime manifest changed");
    for (const file of manifest.files) {
      const bytes = fs.readFileSync(path.join(root, file.path));
      if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error("Prepared runtime content changed");
    }
    return { root, manifest, id };
  }
  identifier(manifest) { return manifest.version + "-" + sha256(JSON.stringify(manifest)).slice(0, 16); }
  // Runs synchronously before Electron's ready event and before loading business code.
  selectForLaunch() {
    const state = this.state();
    if (state.trial) {
      state.rejected = [...new Set([...(state.rejected || []), state.trial])];
      state.lastFailure = "上次更新未能完成启动，已自动恢复之前的版本";
      state.trial = null;
    }
    let active;
    try { active = this.descriptor(state.active); }
    catch {
      try { active = this.descriptor(state.previous); state.active = state.previous; }
      catch { active = this.bundled; state.active = null; }
      state.previous = null; state.lastFailure = "更新文件不可用，已恢复之前的版本";
    }
    if (compareVersions(active.manifest.version, this.bundled.manifest.version) <= 0) {
      active = this.bundled; state.active = null;
    }
    let pending;
    try { pending = state.pending && this.descriptor(state.pending); }
    catch { state.pending = null; state.lastFailure = "未完成的更新未启用，继续使用原版本"; }
    if (pending && !(state.rejected || []).includes(pending.id) && compareVersions(pending.manifest.version, active.manifest.version) > 0) {
      state.trial = pending.id;
      active = pending;
    }
    state.pending = null;
    this.current = active;
    this.save(state);
    return active;
  }
  confirmLaunch() {
    const state = this.state();
    if (this.current.id && state.trial === this.current.id) {
      state.previous = state.active;
      state.active = this.current.id;
      state.trial = null;
      state.lastFailure = null;
      this.save(state);
    }
  }
  failLaunch(reason) {
    const state = this.state();
    if (!state.trial) return false;
    state.rejected = [...new Set([...(state.rejected || []), state.trial])];
    state.trial = null;
    state.pending = null;
    state.lastFailure = "更新启动失败，已恢复之前的版本：" + String(reason).slice(0, 240);
    this.save(state);
    return true;
  }
  pending() {
    const id = this.state().pending;
    try { return id && this.descriptor(id); } catch { return null; }
  }
  async latest(repository, signal) {
    const request = async url => {
      const response = await this.fetch(url, { signal, headers: { Accept: "application/vnd.github+json" } });
      if (!response.ok) throw new Error("GitHub 更新请求失败 (" + response.status + ")");
      return response.json();
    };
    const release = await request(`https://api.github.com/repos/${repository}/releases/latest`);
    if (release.draft || release.prerelease) throw new Error("GitHub 未返回正式版本");
    const asset = release.assets?.find(file => file.name === MANIFEST_NAME);
    if (!asset) throw new Error("此 Release 尚未包含业务更新清单");
    const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/${MANIFEST_NAME}`;
    const manifest = validateManifest(await request(url), this.shell, repository);
    if (release.tag_name !== "v" + manifest.version) throw new Error("Release and business update versions do not match");
    return manifest;
  }
  async readBlob(manifest, file, signal, onBytes) {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let timer;
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error("业务更新下载长时间没有进展，请检查 GitHub 下载连接后重试")), this.downloadIdleMs); };
    touch();
    try {
      const response = await this.fetch(`https://github.com/${manifest.repository}/releases/download/v${manifest.version}/${file.asset}`, { signal: combined });
      if (!response.ok) throw new Error("业务内容下载失败 (" + response.status + ")");
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        touch(); bytes += chunk.length;
        if (bytes > file.downloadSize) throw new Error("业务内容长度不符");
        chunks.push(Buffer.from(chunk)); onBytes(chunk.length);
      }
      const packed = Buffer.concat(chunks);
      if (bytes !== file.downloadSize || sha256(packed) !== file.downloadSha256) throw new Error("业务内容下载不完整或校验失败");
      const content = await decompress(packed, { maxOutputLength: Math.max(1, file.size) });
      if (content.length !== file.size || sha256(content) !== file.sha256) throw new Error("业务内容校验失败");
      return content;
    } finally { clearTimeout(timer); }
  }
  async removeStaging(directory) {
    const parent = path.resolve(this.root, "versions");
    if (path.dirname(path.resolve(directory)) !== parent || !path.basename(directory).startsWith(".staging-"))
      throw new Error("Invalid runtime staging cleanup target");
    await fsp.rm(directory, { recursive: true, force: true });
  }
  async prepare(manifest, { signal = new AbortController().signal, onProgress = () => {} } = {}) {
    validateManifest(manifest, this.shell);
    const id = this.identifier(manifest), state = this.state();
    if ((state.rejected || []).includes(id)) throw new Error("此版本曾启动失败，等待修复后的新版本");
    const cache = path.join(this.root, "content");
    await fsp.mkdir(cache, { recursive: true });
    const existing = new Map(this.current.manifest.files.map(file => [file.sha256, file]));
    const available = new Map(), missing = new Map();
    for (const file of manifest.files) {
      signal.throwIfAborted();
      let bytes;
      try { bytes = await fsp.readFile(path.join(cache, file.sha256)); } catch {}
      if (!bytes || bytes.length !== file.size || sha256(bytes) !== file.sha256) {
        const previous = existing.get(file.sha256);
        try { bytes = previous && await fsp.readFile(path.join(this.current.root, previous.path)); } catch {}
      }
      if (bytes && bytes.length === file.size && sha256(bytes) === file.sha256) available.set(file.sha256, bytes);
      else missing.set(file.sha256, file);
    }
    const downloadTotal = [...missing.values()].reduce((sum, file) => sum + file.downloadSize, 0);
    let downloadedBytes = 0;
    const report = () => onProgress({ progress: downloadTotal ? Math.min(99, 100 * downloadedBytes / downloadTotal) : 99,
      downloadedBytes, downloadTotal, updatedFiles: missing.size, reusedFiles: manifest.files.length - missing.size });
    report();
    const staging = path.join(this.root, "versions", ".staging-" + crypto.randomUUID());
    await fsp.mkdir(staging, { recursive: true });
    try {
      for (const [hash, file] of missing) {
        const bytes = await this.readBlob(manifest, file, signal, amount => { downloadedBytes += amount; report(); });
        const temporary = path.join(cache, hash + "." + crypto.randomUUID() + ".tmp");
        await fsp.writeFile(temporary, bytes);
        await fsp.rename(temporary, path.join(cache, hash));
        available.set(hash, bytes);
      }
      for (const file of manifest.files) {
        signal.throwIfAborted();
        const target = path.join(staging, file.path);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, available.get(file.sha256));
      }
      writeJSON(path.join(staging, MANIFEST_NAME), manifest);
      const target = path.join(this.root, "versions", id);
      try { await fsp.rename(staging, target); }
      catch (error) { if (!(await fsp.stat(target).catch(() => null))?.isDirectory()) throw error; this.descriptor(id); }
      signal.throwIfAborted();
      // A single atomic pointer is written only after every required file is present.
      const currentState = this.state(); currentState.pending = id; this.save(currentState);
      onProgress({ progress: 100, downloadedBytes, downloadTotal, updatedFiles: missing.size, reusedFiles: manifest.files.length - missing.size });
      return this.descriptor(id);
    } finally { await this.removeStaging(staging); }
  }
}
module.exports = { RuntimeStore, writeJSON };
