const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const yaml = require("js-yaml");
const { ciVersion, prepare } = require("../scripts/prepare-ci.cjs");
const { verifyRelease } = require("../scripts/verify-release.cjs");
const { publish } = require("../scripts/publish-release.cjs");
const { contentFixture } = require("./fixtures/content.cjs");
const { buildContent } = require("../scripts/build-content.cjs");
const repository = "fictional-owner/fictional-client";
const sourceSha = "a".repeat(40);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fictional-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installer = "Hermes-Classroom-0.1.42-x64-Setup.exe";
  const content = Buffer.from(
    "Fictional installer test data; this is not an executable.",
  );
  const sha512 = crypto.createHash("sha512").update(content).digest("base64");
  await fs.writeFile(path.join(root, installer), content);
  await fs.writeFile(
    path.join(root, `${installer}.blockmap`),
    "fictional block map",
  );
  await fs.writeFile(
    path.join(root, "latest.yml"),
    yaml.dump({
      version: "0.1.42",
      path: installer,
      sha512,
      files: [{ url: installer, size: content.length, sha512 }],
    }),
  );
  const businessFixture = await contentFixture(t);
  await buildContent(businessFixture.nextSource, root, { version: "0.1.42", repository, sourceSha });
  await verifyRelease(root, "0.1.42", {
    source_repository: repository,
    source_sha: sourceSha,
  });
  return root;
}

function fakeApi(options = {}) {
  const calls = [];
  let headReads = 0;
  const release = {
    id: 71,
    draft: true,
    assets: [],
    body: `<!-- classroom-source:${sourceSha} -->`,
    upload_url:
      "https://uploads.github.com/repos/fictional-owner/fictional-client/releases/71/assets{?name,label}",
    html_url:
      "https://github.com/fictional-owner/fictional-client/releases/tag/v0.1.42",
    ...options.release,
  };
  const api = async (endpoint, method = "GET", body) => {
    calls.push({ endpoint, method, body });
    if (endpoint === `/repos/${repository}`) return { visibility: "public" };
    if (endpoint.endsWith("/git/ref/heads/main"))
      return {
        object: {
          sha:
            options.changedDuringUpload && headReads++
              ? "b".repeat(40)
              : sourceSha,
        },
      };
    if (endpoint.endsWith("/releases/tags/v0.1.42"))
      return options.release ? release : null;
    if (endpoint.endsWith("/releases/latest")) return options.latest || null;
    if (method === "POST" && endpoint.endsWith("/releases")) {
      assert.equal(body.draft, true);
      assert.equal(body.target_commitish, sourceSha);
      return release;
    }
    if (endpoint.startsWith("https://uploads.github.com/")) {
      const bytes = await fs.readFile(body.file);
      return {
        state: "uploaded",
        size: bytes.length,
        digest: `sha256:${options.badDigest ? "0".repeat(64) : crypto.createHash("sha256").update(bytes).digest("hex")}`,
      };
    }
    if (method === "PATCH") {
      assert.equal(
        calls.filter((call) =>
          call.endpoint.startsWith("https://uploads.github.com/"),
        ).length,
        13,
      );
      assert.deepEqual(body, { draft: false, make_latest: "true" });
      return { ...release, draft: false };
    }
    if (method === "DELETE") return null;
    throw new Error(`Unexpected fake API operation: ${method} ${endpoint}`);
  };
  return { api, calls };
}

test("CI versions increase automatically and reruns keep package and lock in sync", async (t) => {
  assert.equal(ciVersion("0.1.0", "42"), "0.1.42");
  assert.equal(ciVersion("0.1.42", "42"), "0.1.42");
  assert.equal(ciVersion("0.2.0", "43"), "0.2.43");
  assert.throws(() => ciVersion("0.1.0", "65536"), /16-bit/);
  assert.throws(() => ciVersion("0.1.0", "0"), /positive/);
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "fictional-ci-version-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ version: "0.1.0" }),
  );
  await fs.writeFile(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      version: "0.1.0",
      packages: { "": { version: "0.1.0" } },
    }),
  );
  assert.equal(prepare(root, "42"), "0.1.42");
  const lock = JSON.parse(
    await fs.readFile(path.join(root, "package-lock.json"), "utf8"),
  );
  assert.equal(lock.version, lock.packages[""].version);
});

test("only a matching manifest and unchanged build artifacts can be published", async (t) => {
  const root = await fixture(t);
  await assert.rejects(verifyRelease(root, "0.1.43"), /manifest/);
  await fs.appendFile(
    path.join(root, "Hermes-Classroom-0.1.42-x64-Setup.exe"),
    "changed",
  );
  await assert.rejects(verifyRelease(root, "0.1.42"), /SHA-512/);
  const { api, calls } = fakeApi();
  await assert.rejects(
    publish(root, { repository, sourceSha, api }),
    /changed/,
  );
  assert.equal(calls.length, 0);
});

test("release stays a draft until GitHub confirms all installer and business content digests", async (t) => {
  const root = await fixture(t);
  const { api, calls } = fakeApi();
  const result = await publish(root, { repository, sourceSha, api, log() {} });
  assert.equal(result.state, "published");
  assert.equal(calls.at(-1).method, "PATCH");
  const bad = fakeApi({ badDigest: true });
  await assert.rejects(
    publish(root, { repository, sourceSha, api: bad.api }),
    /digest/,
  );
  assert.equal(
    bad.calls.some((call) => call.method === "PATCH"),
    false,
  );
});

test("newer code or a newer release prevents an old run replacing the latest update", async (t) => {
  const root = await fixture(t);
  for (const options of [
    { changedDuringUpload: true },
    { latest: { tag_name: "v0.1.43" } },
  ]) {
    const { api, calls } = fakeApi(options);
    const result = await publish(root, {
      repository,
      sourceSha,
      api,
      log() {},
    });
    assert.equal(result.state, "superseded");
    assert.equal(
      calls.some((call) => call.method === "PATCH"),
      false,
    );
  }
});

test("rerunning a published version preserves its original installer and source identity", async (t) => {
  const root = await fixture(t);
  const info = JSON.parse(
    await fs.readFile(path.join(root, "build-info.json"), "utf8"),
  );
  const infoBytes = await fs.readFile(path.join(root, "build-info.json"));
  const assets = [...info.assets, { name: "build-info.json", size: infoBytes.length, sha256: crypto.createHash("sha256").update(infoBytes).digest("hex") }].map(
    (asset) => ({ ...asset, name: path.basename(asset.name), state: "uploaded", digest: "sha256:" + asset.sha256 }),
  );
  const existing = fakeApi({ release: { draft: false, assets } });
  const result = await publish(root, {
    repository,
    sourceSha,
    api: existing.api,
    log() {},
  });
  assert.equal(result.state, "existing");
  assert.equal(
    existing.calls.every((call) => call.method === "GET"),
    true,
  );
  const wrong = fakeApi({ release: { body: "belongs to a different source" } });
  await assert.rejects(
    publish(root, { repository, sourceSha, api: wrong.api }),
    /different source/,
  );
});
