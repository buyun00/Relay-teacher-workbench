const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Updates } = require("../electron/core/updater.cjs");

function fixture(options = {}) {
  let prepared = null, restarted = 0, checks = 0;
  const store = {
    pending: () => prepared,
    async latest(_repo, signal) { signal.throwIfAborted(); checks++; return { version: "0.1.2" }; },
    async prepare(manifest, { onProgress }) {
      onProgress({ progress: 100, downloadedBytes: 73, downloadTotal: 73, updatedFiles: 1, reusedFiles: 20 });
      return prepared = { manifest };
    },
  };
  const client = {
    version: "0.1.1", update: {}, importer: { active: null, scanning: false }, sendingChats: new Set(),
    config: () => ({ releaseRepo: "fictional-owner/fictional-content", pauseUploads: true }),
    changed() {}, snapshot: () => ({ tasks: [] }),
  };
  const updates = new Updates(store, client, { packaged: true, restart: async () => restarted++, ...options });
  return { store, client, updates, restarted: () => restarted, checks: () => checks };
}

function fakeClock() {
  let now = 0, sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.at <= now) {
        timers.delete(id); timer.callback();
      }
      await new Promise(resolve => setImmediate(resolve));
    },
    pending: () => timers.size,
  };
}

test("startup and periodic checks discover and download updates without settings or manual actions", async () => {
  const clock = fakeClock();
  const { client, updates, checks, restarted } = fixture({ clock });
  updates.start(); updates.start();
  assert.equal(clock.pending(), 1);
  await clock.advance(9999); assert.equal(checks(), 0);
  await clock.advance(1); assert.equal(checks(), 1);
  assert.equal(client.update.state, "downloaded");
  assert.equal(client.update.readyVersion, "0.1.2");
  assert.equal(restarted(), 0);
  await clock.advance(30 * 60 * 1000); assert.equal(checks(), 2);
  updates.stop();
  await clock.advance(30 * 60 * 1000); assert.equal(checks(), 2);
  assert.equal(clock.pending(), 0);
});

test("automatic network failures retry after five minutes and recover without visiting settings", async () => {
  const clock = fakeClock();
  const { store, client, updates, checks } = fixture({ clock });
  const latest = store.latest;
  let offline = true;
  store.latest = async (...args) => {
    if (offline) throw new Error("FICTIONAL disconnected network");
    return latest(...args);
  };
  updates.start();
  await clock.advance(10000);
  assert.equal(client.update.state, "error");
  offline = false;
  await clock.advance(5 * 60 * 1000 - 1); assert.equal(checks(), 0);
  await clock.advance(1); assert.equal(checks(), 1);
  assert.equal(client.update.state, "downloaded");
  updates.stop();
});

test("window focus checks are throttled, while wake and manual retry check immediately", async () => {
  const clock = fakeClock();
  const { updates, checks } = fixture({ clock });
  updates.start();
  await clock.advance(10000); assert.equal(checks(), 1);
  await updates.checkAutomatic(); await updates.checkAutomatic(); assert.equal(checks(), 1);
  await clock.advance(60000);
  await Promise.all([updates.checkAutomatic(), updates.checkAutomatic()]); assert.equal(checks(), 2);
  await updates.checkAutomatic(true); assert.equal(checks(), 3);
  await updates.check(); assert.equal(checks(), 4);
  updates.stop();
});

test("local and development clients never schedule automatic network checks", async () => {
  for (const options of [{ channel: "local" }, { packaged: false }]) {
    const clock = fakeClock();
    const { updates, checks } = fixture({ ...options, clock });
    updates.start(); await updates.checkAutomatic(true);
    await clock.advance(30 * 60 * 1000);
    assert.equal(clock.pending(), 0); assert.equal(checks(), 0);
  }
});

test("available version is published before downloading and a ready version remains actionable after a failed recheck", async () => {
  const { store, client, updates, restarted } = fixture();
  const states = [];
  client.changed = () => states.push({ ...client.update });
  await updates.check();
  assert.ok(states.some(state => state.state === "available" && state.version === "0.1.2"));
  store.latest = async () => { throw new Error("FICTIONAL offline during recheck"); };
  await updates.check();
  assert.ok(states.some(state => state.state === "checking" && state.readyVersion === "0.1.2"));
  assert.equal(client.update.state, "error");
  assert.equal(client.update.readyVersion, "0.1.2");
  await updates.apply(); assert.equal(restarted(), 1);
});

test("quitting cancels an active download and does not schedule another automatic attempt", async () => {
  const clock = fakeClock();
  const { store, updates, checks } = fixture({ clock });
  let entered;
  const downloading = new Promise(resolve => { entered = resolve; });
  store.prepare = async (_manifest, { signal }) => {
    entered();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("FICTIONAL quit")), { once: true }));
  };
  updates.start();
  const attempt = updates.check(); await downloading;
  updates.stop(); await attempt;
  await clock.advance(30 * 60 * 1000);
  assert.equal(clock.pending(), 0); assert.equal(checks(), 1);
});

test("new content downloads automatically and becomes pending without invoking any installer or restarting on download", async () => {
  const { store, client, updates, restarted } = fixture();
  await updates.check();
  assert.equal(client.update.state, "downloaded");
  assert.equal(client.update.downloadedBytes, 73);
  assert.equal(store.pending().manifest.version, "0.1.2");
  assert.equal(restarted(), 0);
  await updates.apply();
  assert.equal(restarted(), 1);
  assert.equal(client.config().pauseUploads, true);
});

test("local installers and development previews never access GitHub, including after settings change", async () => {
  for (const options of [{ channel: "local" }, { packaged: false }]) {
    const { store, client, updates, checks, restarted } = fixture(options);
    store.latest = async () => { throw new Error("Local/development must not access GitHub"); };
    await updates.check();
    client.config = () => ({ releaseRepo: "fictional-owner/changed" });
    updates.configure();
    await updates.check();
    assert.equal(checks(), 0); assert.equal(restarted(), 0);
    assert.equal(client.update.state, options.channel ? "local" : "development");
    await assert.rejects(updates.apply(), /尚未准备/);
  }
});

test("immediate activation waits for copying, scanning, or a running chat", async () => {
  const { client, updates, restarted } = fixture();
  await updates.check();
  client.importer.active = { filename: "fictional.wav" };
  await assert.rejects(updates.apply(), /等待本地复制/);
  client.importer.active = null; client.importer.scanning = true;
  await assert.rejects(updates.apply(), /等待本地复制/);
  client.importer.scanning = false; client.sendingChats.add("fictional-chat");
  await assert.rejects(updates.apply(), /回复结束/);
  client.sendingChats.clear(); client.snapshot = () => ({ tasks: [{ state: "running" }] });
  await assert.rejects(updates.apply(), /回复结束/);
  assert.equal(restarted(), 0);
});

test("prepared content survives checks and a later release replaces the pending snapshot", async () => {
  const { store, client, updates } = fixture();
  await updates.check(); await updates.check();
  assert.equal(client.update.state, "downloaded");
  store.latest = async () => ({ version: "0.1.5" });
  await updates.check();
  assert.equal(store.pending().manifest.version, "0.1.5");
});

test("incompatible bases fail explicitly and never fall back to installer downloads", async () => {
  const { store, client, updates, restarted } = fixture();
  store.latest = async () => { const error = new Error("FICTIONAL incompatible base"); error.code = "BASE_INCOMPATIBLE"; throw error; };
  store.prepare = async () => { throw new Error("No content should download"); };
  await updates.check();
  assert.equal(client.update.state, "incompatible"); assert.equal(restarted(), 0);
  await assert.rejects(updates.apply(), /尚未准备/);
});

test("cancelled attempts finish before retry and cannot overwrite a successful later check", async () => {
  const { store, client, updates } = fixture();
  store.prepare = async (_manifest, { signal }) => new Promise((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(new Error("FICTIONAL cancelled")), { once: true }));
  const first = updates.check();
  await new Promise(resolve => setImmediate(resolve));
  updates.cancel(); await first;
  assert.equal(client.update.state, "error");
  store.prepare = async manifest => { store.pending = () => ({ manifest }); return { manifest }; };
  await updates.check();
  assert.equal(client.update.state, "downloaded");
});
