const fs = require("node:fs");
const path = require("node:path");

function ciVersion(base, runNumber) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (!match || !/^[1-9]\d*$/.test(String(runNumber)))
    throw new Error(
      "A stable package version and positive GITHUB_RUN_NUMBER are required",
    );
  const parts = [Number(match[1]), Number(match[2]), Number(runNumber)];
  if (parts.some((n) => !Number.isSafeInteger(n) || n > 65535))
    throw new Error(
      "Version components must fit the Windows 16-bit version fields",
    );
  // Major/minor come from source; the workflow counter owns the patch version.
  // Re-running the same workflow run retains the version, without committing a bump.
  return parts.join(".");
}

function prepare(root, runNumber) {
  const pkgPath = path.join(root, "package.json");
  const lockPath = path.join(root, "package-lock.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const version = ciVersion(pkg.version, runNumber);
  pkg.version = lock.version = lock.packages[""].version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  return version;
}

if (require.main === module) {
  console.log(
    `CI installer version: ${prepare(path.resolve(__dirname, ".."), process.env.GITHUB_RUN_NUMBER)}`,
  );
}
module.exports = { ciVersion, prepare };
