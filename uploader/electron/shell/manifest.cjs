const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_NAME = "classroom-update.json";
const BUNDLED_MANIFEST = "runtime-manifest.json";
const SCHEMA = 1;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const stableVersion = (value) => /^\d+\.\d+\.\d+$/.test(value || "");
function compareVersions(left, right) {
  if (!stableVersion(left) || !stableVersion(right)) throw new Error("Invalid update version");
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}
function shellContract(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const files = ["electron/bootstrap.cjs", ...fs.readdirSync(path.join(root, "electron/shell"))
    .filter(name => name.endsWith(".cjs")).sort().map(name => "electron/shell/" + name)];
  const shell = { api: 1, electron: pkg.devDependencies.electron, platform: "win32", arch: "x64" };
  // Git's Windows checkout may use CRLF; line-ending conversion is not a base API change.
  shell.key = sha256(JSON.stringify(shell) + files.map(name => "\n" + name + ":" + sha256(fs.readFileSync(path.join(root, name), "utf8").replace(/\r\n/g, "\n"))).join(""));
  return shell;
}
function validateManifest(value, shell, repository) {
  if (value?.schema !== SCHEMA || !stableVersion(value.version) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository || "") ||
      !/^[a-f0-9]{40}$/.test(value.source_sha || "") || !Array.isArray(value.files) || !value.files.length)
    throw new Error("Invalid business update manifest");
  if (repository && value.repository !== repository) throw new Error("Update repository does not match");
  if (!value.shell || !/^[a-f0-9]{64}$/.test(value.shell.key || "")) throw new Error("Missing desktop base contract");
  if (shell && (value.shell.key !== shell.key || value.shell.api !== shell.api ||
      value.shell.electron !== shell.electron || value.shell.platform !== shell.platform || value.shell.arch !== shell.arch)) {
    const error = new Error("此更新需要不同的桌面底座；当前版本继续可用，请手动升级底座后再检查");
    error.code = "BASE_INCOMPATIBLE";
    throw error;
  }
  const paths = new Set();
  for (const file of value.files) {
    const name = file.path;
    if (typeof name !== "string" || name.includes("\\") || name.includes(":") ||
        name.split("/").some(part => !part || part === "." || part === "..") ||
        !(name === "package.json" || name === "electron/main.cjs" || name === "electron/preload.cjs" ||
          name === "electron/release-config.json" || name.startsWith("dist/") ||
          name.startsWith("electron/core/") || name.startsWith("electron/assets/")) || paths.has(name.toLowerCase()) ||
        !/^[a-f0-9]{64}$/.test(file.sha256 || "") || !/^[a-f0-9]{64}$/.test(file.downloadSha256 || "") ||
        file.asset !== `content-${file.sha256}.br` || !Number.isSafeInteger(file.size) || file.size < 0 ||
        !Number.isSafeInteger(file.downloadSize) || file.downloadSize <= 0)
      throw new Error("Invalid business update file");
    paths.add(name.toLowerCase());
  }
  for (const required of ["package.json", "electron/main.cjs", "electron/preload.cjs", "dist/index.html"])
    if (!paths.has(required)) throw new Error("Incomplete business update manifest: " + required);
  return value;
}
module.exports = { MANIFEST_NAME, BUNDLED_MANIFEST, SCHEMA, sha256, stableVersion, compareVersions, shellContract, validateManifest };
