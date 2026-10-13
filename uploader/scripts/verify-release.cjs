const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const yaml = require("js-yaml");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const { MANIFEST_NAME, sha256, validateManifest } = require("../electron/shell/manifest.cjs");
const decompress = promisify(zlib.brotliDecompress);

async function hashes(file) {
  const sha256 = crypto.createHash("sha256");
  const sha512 = crypto.createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) {
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return { sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}

async function verifyRelease(root, version, provenance = {}) {
  const manifest = yaml.load(
    await fsp.readFile(path.join(root, "latest.yml"), "utf8"),
  );
  const installer = `Hermes-Classroom-${version}-x64-Setup.exe`;
  if (
    manifest.version !== version ||
    manifest.files?.length !== 1 ||
    manifest.files[0].url !== installer ||
    manifest.path !== installer
  )
    throw new Error("Update manifest does not match this installer version");
  const business = validateManifest(JSON.parse(await fsp.readFile(path.join(root, MANIFEST_NAME), "utf8")));
  if (business.version !== version || (provenance.source_repository && business.repository !== provenance.source_repository) ||
      (provenance.source_sha && business.source_sha !== provenance.source_sha))
    throw new Error("Business update provenance does not match this release");
  const content = [...new Map(business.files.map(file => [file.asset, file])).values()];
  for (const file of content) {
    const packed = await fsp.readFile(path.join(root, "content", file.asset));
    if (packed.length !== file.downloadSize || sha256(packed) !== file.downloadSha256) throw new Error("Business content changed: " + file.path);
    const bytes = await decompress(packed, { maxOutputLength: Math.max(1, file.size) });
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error("Business content is invalid: " + file.path);
  }
  const assets = [];
  for (const name of [installer, `${installer}.blockmap`, "latest.yml", MANIFEST_NAME, ...content.map(file => "content/" + file.asset)]) {
    const file = path.join(root, name);
    const size = (await fsp.stat(file)).size;
    const hash = await hashes(file);
    if (!size) throw new Error(`Empty update asset: ${name}`);
    if (
      name === installer &&
      (manifest.files[0].size !== size ||
        manifest.files[0].sha512 !== hash.sha512 ||
        manifest.sha512 !== hash.sha512)
    )
      throw new Error("Installer length or SHA-512 does not match latest.yml");
    assets.push({ name, size, sha256: hash.sha256 });
  }
  const info = { version, ...provenance, shell: business.shell, update_schema: business.schema,
    business_download_bytes: content.reduce((sum, file) => sum + file.downloadSize, 0), assets };
  await fsp.writeFile(
    path.join(root, "build-info.json"),
    JSON.stringify(info, null, 2) + "\n",
  );
  return info;
}

if (require.main === module) {
  const pkg = require("../package.json");
  verifyRelease(path.resolve(__dirname, "../release"), pkg.version, {
    source_repository:
      process.env.GITHUB_REPOSITORY || "buyun00/Relay-teacher-workbench",
    source_sha: process.env.GITHUB_SHA || "",
    run_number: process.env.GITHUB_RUN_NUMBER || "",
    run_id: process.env.GITHUB_RUN_ID || "",
  })
    .then((info) => console.log(`Verified update assets for ${info.version}`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
module.exports = { verifyRelease, hashes };
