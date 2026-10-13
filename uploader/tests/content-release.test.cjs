const { test } = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const path = require("node:path");
const yaml = require("js-yaml");
const { sha256, MANIFEST_NAME } = require("../electron/shell/manifest.cjs");
const { hashes, verifyRelease } = require("../scripts/verify-release.cjs");
const { publish } = require("../scripts/publish-release.cjs");
const { contentFixture } = require("./fixtures/content.cjs");
async function releaseFixture(t) {
  const fixture = await contentFixture(t), version = fixture.next.version;
  const installer = `Hermes-Classroom-${version}-x64-Setup.exe`;
  const file = path.join(fixture.output, installer);
  await fsp.writeFile(file, "EXPLICITLY FICTIONAL INSTALLER; NEVER EXECUTE");
  await fsp.writeFile(file + ".blockmap", "EXPLICITLY FICTIONAL BLOCKMAP");
  const digest = await hashes(file), size = (await fsp.stat(file)).size;
  await fsp.writeFile(path.join(fixture.output, "latest.yml"), yaml.dump({ version, path: installer,
    sha512: digest.sha512, files: [{ url: installer, sha512: digest.sha512, size }] }));
  const info = await verifyRelease(fixture.output, version, { source_repository: fixture.options.repository, source_sha: fixture.options.sourceSha });
  return { ...fixture, info };
}
function apiFixture(fixture, options = {}) {
  const calls = [], remote = [];
  const api = async (endpoint, method = "GET", body) => {
    calls.push({ endpoint, method, body });
    if (method === "POST" && endpoint.startsWith("https://uploads.github.com/")) {
      const name = new URL(endpoint).searchParams.get("name");
      const bytes = await fsp.readFile(body.file);
      const asset = { id: remote.length + 1, name, size: bytes.length, state: "uploaded", digest: "sha256:" + sha256(bytes) };
      remote.push(asset); return options.corruptUpload && name.endsWith(".br") ? { ...asset, digest: "sha256:" + "0".repeat(64) } : asset;
    }
    if (method === "POST") return { id: 51, upload_url: "https://uploads.github.com/repos/fictional/releases/51/assets{?name}", assets: [] };
    if (method === "PATCH") return { id: 51, html_url: "https://github.com/fictional-owner/fictional-content/releases/tag/v0.1.2" };
    if (endpoint.endsWith("/git/ref/heads/main")) return { object: { sha: options.superseded ? "f".repeat(40) : fixture.options.sourceSha } };
    if (endpoint.endsWith("/releases/latest")) return options.previous ? { tag_name: "v0.1.1", assets: [{ name: MANIFEST_NAME }] } : null;
    if (endpoint.includes("/releases/tags/")) return options.existing || null;
    return { visibility: "public" };
  };
  return { api, calls, remote, options: { repository: fixture.options.repository, sourceSha: fixture.options.sourceSha, api, log() {},
    readAsset: async () => options.previous } };
}
test("release verification includes every business blob and the source/base contract", async t => {
  const fixture = await releaseFixture(t);
  assert.ok(fixture.info.assets.some(asset => asset.name === MANIFEST_NAME));
  assert.equal(fixture.info.shell.key, fixture.next.shell.key);
  assert.equal(fixture.info.business_download_bytes, fixture.next.files.reduce((sum, file) => sum + file.downloadSize, 0));
  const file = fixture.next.files[0];
  await fsp.writeFile(path.join(fixture.output, "content", file.asset), "FICTIONAL CORRUPTION");
  await assert.rejects(verifyRelease(fixture.output, fixture.next.version), /Business content changed/);
});
test("release is public only after installer, manifest and all content digests are confirmed", async t => {
  const fixture = await releaseFixture(t), remote = apiFixture(fixture);
  assert.equal((await publish(fixture.output, remote.options)).state, "published");
  assert.equal(remote.remote.length, fixture.info.assets.length + 1);
  assert.equal(remote.calls.at(-1).method, "PATCH");
  assert.ok(remote.remote.some(asset => asset.name === MANIFEST_NAME));
  assert.ok(remote.remote.some(asset => asset.name.startsWith("content-")));
});
test("an incomplete business upload stays a draft and cannot become the latest version", async t => {
  const fixture = await releaseFixture(t), remote = apiFixture(fixture, { corruptUpload: true });
  await assert.rejects(publish(fixture.output, remote.options), /digest/);
  assert.equal(remote.calls.filter(call => call.method === "PATCH").length, 0);
});
test("ordinary releases reject a changed desktop base, while an explicit base release can publish", async t => {
  const fixture = await releaseFixture(t), previous = structuredClone(fixture.initial); previous.shell.key = "f".repeat(64);
  const blocked = apiFixture(fixture, { previous });
  await assert.rejects(publish(fixture.output, blocked.options), /Desktop base changed/);
  assert.equal(blocked.calls.filter(call => call.method === "POST").length, 0);
  const explicit = apiFixture(fixture, { previous });
  assert.equal((await publish(fixture.output, { ...explicit.options, allowShellChange: true })).state, "published");
});
test("superseded source never publishes a business update", async t => {
  const fixture = await releaseFixture(t), remote = apiFixture(fixture, { superseded: true });
  assert.equal((await publish(fixture.output, remote.options)).state, "superseded");
  assert.equal(remote.remote.length, 0);
});
