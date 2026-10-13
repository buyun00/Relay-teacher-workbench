const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const { SCHEMA, MANIFEST_NAME, BUNDLED_MANIFEST, sha256, shellContract, validateManifest } = require("../electron/shell/manifest.cjs");
const compress = promisify(zlib.brotliCompress);
async function list(root, relative) {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = relative + "/" + entry.name;
    if (entry.isDirectory()) result.push(...await list(root, name));
    else if (entry.isFile()) result.push(name);
  }
  return result;
}
async function buildContent(root, output, options = {}) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const repository = options.repository || process.env.RELEASE_REPOSITORY || process.env.GITHUB_REPOSITORY || "buyun00/Relay-teacher-workbench";
  const manifest = { schema: SCHEMA, version: options.version || pkg.version, repository,
    source_sha: options.sourceSha || process.env.GITHUB_SHA || "0".repeat(40), shell: shellContract(root), files: [] };
  const names = ["electron/main.cjs", "electron/preload.cjs", "electron/release-config.json",
    ...await list(root, "electron/core"), ...await list(root, "electron/assets"), ...await list(root, "dist")].sort();
  const metadata = Buffer.from(JSON.stringify({ name: pkg.name, productName: pkg.productName, version: manifest.version, classroomBuild: { channel: "release" } }, null, 2) + "\n");
  await fs.mkdir(path.join(output, "content"), { recursive: true });
  for (const name of ["package.json", ...names]) {
    const bytes = name === "package.json" ? metadata : await fs.readFile(path.join(root, name));
    const packed = await compress(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
    const hash = sha256(bytes), asset = `content-${hash}.br`;
    manifest.files.push({ path: name, module: name.startsWith("dist/") ? "interface" : name.startsWith("electron/core/") ? "services" : "desktop",
      sha256: hash, size: bytes.length, asset, downloadSha256: sha256(packed), downloadSize: packed.length });
    await fs.writeFile(path.join(output, "content", asset), packed);
  }
  validateManifest(manifest);
  const serialized = JSON.stringify(manifest, null, 2) + "\n";
  await fs.writeFile(path.join(output, MANIFEST_NAME), serialized);
  if (options.writeBundled !== false) await fs.writeFile(path.join(root, BUNDLED_MANIFEST), serialized);
  return manifest;
}
if (require.main === module) buildContent(path.resolve(__dirname, ".."), path.resolve(__dirname, "../release"))
  .then(manifest => console.log(`Business update ${manifest.version}: ${manifest.files.length} content files, ${manifest.files.reduce((sum, file) => sum + file.downloadSize, 0)} compressed bytes; Electron excluded.`))
  .catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { buildContent };
