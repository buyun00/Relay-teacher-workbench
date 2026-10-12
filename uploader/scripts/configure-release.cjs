const fs = require("node:fs");
const path = require("node:path");
const repository =
  process.env.RELEASE_REPOSITORY ||
  process.env.GITHUB_REPOSITORY ||
  "buyun00/Relay-teacher-workbench";
if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
  throw new Error("RELEASE_REPOSITORY 必须为 owner/repo");
fs.writeFileSync(
  path.join(__dirname, "../electron/release-config.json"),
  JSON.stringify({ repository }, null, 2) + "\n",
);
