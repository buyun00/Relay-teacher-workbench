const { test } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { RuntimeStore } = require("../electron/shell/store.cjs");
const { validateManifest, MANIFEST_NAME, shellContract } = require("../electron/shell/manifest.cjs");
const { buildContent } = require("../scripts/build-content.cjs");
const { contentFixture } = require("./fixtures/content.cjs");

test("updates reuse unchanged content, remove old assets, and commit only after a successful new launch", async t => {
  const fixture = await contentFixture(t);
  const root = path.join(fixture.root, "profile/business-updates");
  const store = new RuntimeStore(root, fixture.source, fixture.initial, { fetch: fixture.fetcher });
  let progress;
  const prepared = await store.prepare(fixture.next, { onProgress: value => progress = value });
  const changed = fixture.next.files.filter(file => !fixture.initial.files.some(previous => previous.sha256 === file.sha256));
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.requests.map(url => path.posix.basename(new URL(url).pathname)).sort(), changed.map(file => file.asset).sort());
  assert.equal(progress.downloadedBytes, changed.reduce((sum, file) => sum + file.downloadSize, 0));
  assert.equal(progress.downloadTotal, progress.downloadedBytes);
  assert.equal(store.current.manifest.version, "0.1.1");
  assert.equal(await fsp.stat(path.join(prepared.root, "dist/removed.txt")).catch(() => null), null);
  const launched = new RuntimeStore(root, fixture.source, fixture.initial);
  assert.equal(launched.selectForLaunch().manifest.version, "0.1.2");
  assert.ok(launched.state().trial);
  assert.equal(launched.state().active, null);
  launched.confirmLaunch();
  assert.equal(launched.state().trial, null);
  assert.equal(new RuntimeStore(root, fixture.source, fixture.initial).selectForLaunch().manifest.version, "0.1.2");
});

test("incomplete downloads never switch the runtime and a retry reuses already verified new files", async t => {
  const fixture = await contentFixture(t);
  const root = path.join(fixture.root, "profile/business-updates");
  let calls = 0;
  const store = new RuntimeStore(root, fixture.source, fixture.initial, { fetch: async (url, options) => {
    if (++calls === 2) return new Response("FICTIONAL CORRUPT DOWNLOAD");
    return fixture.fetcher(url, options);
  } });
  await assert.rejects(store.prepare(fixture.next), /校验|长度/);
  assert.equal(store.state().pending, null);
  assert.equal(store.selectForLaunch().manifest.version, "0.1.1");
  fixture.requests.length = 0;
  store.fetch = fixture.fetcher;
  await store.prepare(fixture.next);
  assert.equal(fixture.requests.length, 1);
});

test("failed startup returns to the last confirmed release, skips the failed version, and accepts a later fix", async t => {
  const fixture = await contentFixture(t);
  const root = path.join(fixture.root, "profile/business-updates");
  const store = new RuntimeStore(root, fixture.source, fixture.initial, { fetch: fixture.fetcher });
  await store.prepare(fixture.next);
  store.selectForLaunch();
  // A new process arriving while trial is still set is a failed or interrupted boot.
  const restarted = new RuntimeStore(root, fixture.source, fixture.initial, { fetch: fixture.fetcher });
  assert.equal(restarted.selectForLaunch().manifest.version, "0.1.1");
  await assert.rejects(restarted.prepare(fixture.next), /启动失败/);
  const fixed = await buildContent(fixture.nextSource, fixture.output, { ...fixture.options, version: "0.1.4" });
  await restarted.prepare(fixed);
  assert.equal(restarted.selectForLaunch().manifest.version, "0.1.4");
  restarted.confirmLaunch();
  const newer = await buildContent(fixture.nextSource, fixture.output, { ...fixture.options, version: "0.1.7" });
  await restarted.prepare(newer);
  restarted.selectForLaunch();
  assert.equal(restarted.failLaunch("EXPLICITLY FICTIONAL BOOT FAILURE"), true);
  assert.equal(new RuntimeStore(root, fixture.source, fixture.initial).selectForLaunch().manifest.version, "0.1.4");
});

test("stalled downloads abort without installing or changing the current version", async t => {
  const fixture = await contentFixture(t);
  const store = new RuntimeStore(path.join(fixture.root, "updates"), fixture.source, fixture.initial, {
    downloadIdleMs: 15, fetch: async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from("FIC"));
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    })),
  });
  await assert.rejects(store.prepare(fixture.next), /没有进展/);
  assert.equal(store.state().pending, null);
  assert.equal(store.current.manifest.version, "0.1.1");
});

test("corrupted prepared code and malformed state recover without touching teacher data", async t => {
  const fixture = await contentFixture(t);
  const root = path.join(fixture.root, "updates");
  const store = new RuntimeStore(root, fixture.source, fixture.initial, { fetch: fixture.fetcher });
  const prepared = await store.prepare(fixture.next);
  const teacherData = path.join(fixture.root, "FICTIONAL-TEACHER-DATA.txt");
  await fsp.writeFile(teacherData, "EXPLICITLY FICTIONAL RETAINED DATA");
  await fsp.writeFile(path.join(prepared.root, "electron/main.cjs"), "throw new Error('FICTIONAL CORRUPTION');");
  assert.equal(store.selectForLaunch().manifest.version, "0.1.1");
  await fsp.writeFile(store.statePath, "{FICTIONAL INTERRUPTED STATE");
  assert.equal(store.selectForLaunch().manifest.version, "0.1.1");
  assert.equal(await fsp.readFile(teacherData, "utf8"), "EXPLICITLY FICTIONAL RETAINED DATA");
  assert.ok((await fsp.readdir(root)).some(name => name.startsWith("state.json.invalid.")));
});

test("manifest validation rejects incompatible bases, duplicate or escaping paths, and missing preload", async t => {
  const { next, initial } = await contentFixture(t);
  const incompatible = structuredClone(next); incompatible.shell.key = "f".repeat(64);
  assert.throws(() => validateManifest(incompatible, initial.shell), error => error.code === "BASE_INCOMPATIBLE");
  const escaping = structuredClone(next); escaping.files[0].path = "../FICTIONAL.txt";
  assert.throws(() => validateManifest(escaping), /Invalid business update file/);
  const duplicate = structuredClone(next); duplicate.files.push({ ...next.files[0], path: next.files[0].path.toUpperCase() });
  assert.throws(() => validateManifest(duplicate), /Invalid business update file/);
  const incomplete = structuredClone(next); incomplete.files = incomplete.files.filter(file => file.path !== "electron/preload.cjs");
  assert.throws(() => validateManifest(incomplete), /Incomplete/);
});

test("GitHub release discovery requests only the business manifest and validates its tag", async t => {
  const fixture = await contentFixture(t), urls = [];
  const store = new RuntimeStore(path.join(fixture.root, "updates"), fixture.source, fixture.initial, { fetch: async url => {
    urls.push(url);
    return Response.json(url.includes("api.github.com") ? { tag_name: "v0.1.2", assets: [{ name: MANIFEST_NAME }] } : fixture.next);
  } });
  assert.equal((await store.latest(fixture.next.repository, new AbortController().signal)).version, "0.1.2");
  assert.equal(urls.length, 2);
  assert.ok(urls.every(url => !/\.exe|latest\.yml|\.blockmap/.test(url)));
});

test("base identity ignores business revisions and Git line endings but changes with the Electron runtime", async t => {
  const fixture = await contentFixture(t), root = fixture.nextSource;
  const original = shellContract(root);
  assert.equal(original.key, fixture.initial.shell.key);
  for (const name of ["electron/bootstrap.cjs", ... (await fsp.readdir(path.join(root, "electron/shell"))).map(name => "electron/shell/" + name)]) {
    const filename = path.join(root, name);
    await fsp.writeFile(filename, (await fsp.readFile(filename, "utf8")).replace(/\r?\n/g, "\r\n"));
  }
  assert.equal(shellContract(root).key, original.key);
  const filename = path.join(root, "package.json"), pkg = JSON.parse(await fsp.readFile(filename, "utf8"));
  pkg.devDependencies.electron = "99.0.0";
  await fsp.writeFile(filename, JSON.stringify(pkg));
  assert.notEqual(shellContract(root).key, original.key);
});
