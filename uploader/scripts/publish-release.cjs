const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { MANIFEST_NAME, validateManifest } = require("../electron/shell/manifest.cjs");

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function github(token) {
  if (!token)
    throw new Error("The publish job needs its repository GITHUB_TOKEN");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "hermes-classroom-release",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  return async (endpoint, method = "GET", body) => {
    const uploading = endpoint.startsWith("https://uploads.github.com/");
    const response = await fetch(
      uploading ? endpoint : `https://api.github.com${endpoint}`,
      {
        method,
        headers: {
          ...headers,
          ...(uploading
            ? {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(body.size),
              }
            : body
              ? { "Content-Type": "application/json" }
              : {}),
        },
        body: uploading
          ? fs.createReadStream(body.file)
          : body
            ? JSON.stringify(body)
            : undefined,
        ...(uploading ? { duplex: "half" } : {}),
        signal: AbortSignal.timeout(uploading ? 300000 : 30000),
      },
    );
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(`GitHub ${method} failed (${response.status})`);
    return response.status === 204 ? null : response.json();
  };
}

async function publish(root, options) {
  const { repository, sourceSha, api, notes = "", log = console.log,
    readAsset = async asset => {
      const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error("Cannot read previous desktop base contract");
      return response.json();
    } } = options;
  const info = JSON.parse(
    await fsp.readFile(path.join(root, "build-info.json"), "utf8"),
  );
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "") ||
    !/^[a-f0-9]{40}$/.test(sourceSha || "") ||
    info.source_repository !== repository ||
    info.source_sha !== sourceSha ||
    !/^\d+\.\d+\.\d+$/.test(info.version)
  )
    throw new Error(
      "Build provenance does not match this source repository and commit",
    );
  const installer = `Hermes-Classroom-${info.version}-x64-Setup.exe`;
  const manifest = validateManifest(JSON.parse(await fsp.readFile(path.join(root, MANIFEST_NAME), "utf8")), info.shell, repository);
  if (manifest.version !== info.version || manifest.source_sha !== sourceSha) throw new Error("Business update does not match the source commit");
  const content = [...new Set(manifest.files.map(file => "content/" + file.asset))];
  const names = [installer, `${installer}.blockmap`, "latest.yml", MANIFEST_NAME, ...content];
  if (
    info.assets?.length !== names.length ||
    names.some(
      (name) => info.assets.filter((asset) => asset.name === name).length !== 1,
    )
  )
    throw new Error(
      "The complete installer, business manifest and every content file are required",
    );
  const assets = [...info.assets];
  for (const asset of assets) {
    const file = path.join(root, asset.name);
    if (
      (await fsp.stat(file)).size !== asset.size ||
      (await sha256(file)) !== asset.sha256
    )
      throw new Error(
        `Build artifact changed after verification: ${asset.name}`,
      );
  }
  const infoPath = path.join(root, "build-info.json");
  assets.push({
    name: "build-info.json",
    size: (await fsp.stat(infoPath)).size,
    sha256: await sha256(infoPath),
  });
  const base = `/repos/${repository}`;
  const repo = await api(base);
  if (repo?.visibility !== "public")
    throw new Error("Anonymous client updates need a public repository");
  const isCurrent = async () =>
    (await api(`${base}/git/ref/heads/main`))?.object?.sha === sourceSha;
  if (!(await isCurrent())) {
    log("A newer main commit exists; this build will not become an update.");
    return { state: "superseded" };
  }
  const tag = `v${info.version}`;
  const marker = `<!-- classroom-source:${sourceSha} -->`;
  let release = await api(`${base}/releases/tags/${tag}`);
  if (release && !release.body?.includes(marker))
    throw new Error("Release version belongs to a different source commit");
  if (release && !release.draft) {
    if (
      assets.some(
        (asset) =>
          !release.assets.some(
            (remote) =>
              remote.name === path.basename(asset.name) &&
              remote.state === "uploaded" &&
              remote.size === asset.size && remote.digest === `sha256:${asset.sha256}`,
          ),
      )
    )
      throw new Error(
        "Published release is incomplete; create a new version instead of overwriting it",
      );
    log(`Already published ${tag}; keeping its original immutable installer.`);
    return { state: "existing", url: release.html_url };
  }
  const latest = await api(`${base}/releases/latest`);
  const previousManifest = latest?.assets?.find(asset => asset.name === MANIFEST_NAME);
  if (previousManifest) {
    const previous = validateManifest(await readAsset(previousManifest), undefined, repository);
    if (previous.shell.key !== manifest.shell.key && !options.allowShellChange)
      throw new Error("Desktop base changed. Ordinary releases must preserve the content-update base; use an explicit base release for a manual base upgrade.");
  }
  const lastVersion = /^v(\d+)\.(\d+)\.(\d+)$/.exec(latest?.tag_name || "");
  if (lastVersion) {
    const previous = lastVersion.slice(1).map(Number);
    const proposed = info.version.split(".").map(Number);
    let comparison = 0;
    for (let i = 0; i < 3 && !comparison; i++)
      comparison = Math.sign(proposed[i] - previous[i]);
    if (comparison <= 0) {
      log("A newer version is already published; keeping the latest update.");
      return { state: "superseded" };
    }
  }
  if (!release)
    release = await api(`${base}/releases`, "POST", {
      tag_name: tag,
      target_commitish: sourceSha,
      name: `课堂连接 ${info.version}`,
      body: `${marker}\n\n${notes.replace(/^# .*\r?\n/, "")}\n\n源码提交：[${sourceSha.slice(0, 8)}](https://github.com/${repository}/commit/${sourceSha})\n\n已有新版客户端自动下载变化的业务内容，下次启动启用，无需重新安装。Setup.exe 供首次安装及旧客户端的一次性迁移使用。CI 已核对业务清单、内容文件、安装包和来源信息。`,
      draft: true,
      prerelease: false,
      generate_release_notes: true,
    });
  if (
    !release?.id ||
    !release.upload_url?.startsWith("https://uploads.github.com/")
  )
    throw new Error("GitHub did not return a valid draft release");
  for (const old of release.assets || []) {
    if (!assets.some((asset) => path.basename(asset.name) === old.name))
      throw new Error("Draft contains unrelated release assets");
    await api(`${base}/releases/assets/${old.id}`, "DELETE");
  }
  for (const asset of assets) {
    const url = `${release.upload_url.split("{")[0]}?name=${encodeURIComponent(path.basename(asset.name))}`;
    const remote = await api(url, "POST", {
      file: path.join(root, asset.name),
      size: asset.size,
    });
    if (
      remote?.state !== "uploaded" ||
      remote.size !== asset.size ||
      remote.digest !== `sha256:${asset.sha256}`
    )
      throw new Error(
        `GitHub did not confirm the complete asset digest: ${asset.name}`,
      );
  }
  // The updater sees only a complete, checked release. Interrupted uploads stay drafts.
  if (!(await isCurrent())) {
    log(
      "Main changed during upload; the draft is retained without publishing.",
    );
    return { state: "superseded" };
  }
  release = await api(`${base}/releases/${release.id}`, "PATCH", {
    draft: false,
    make_latest: "true",
  });
  log(`Published ${tag}: ${release.html_url}`);
  return { state: "published", url: release.html_url };
}

if (require.main === module) {
  publish(path.resolve(process.argv[2] || "installer"), {
    repository: process.env.GITHUB_REPOSITORY,
    sourceSha: process.env.GITHUB_SHA,
    api: github(process.env.GH_TOKEN),
    notes: fs.readFileSync(path.resolve(__dirname, "../CHANGELOG.md"), "utf8"),
    allowShellChange: process.env.ALLOW_SHELL_CHANGE === "true",
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { publish, github };
