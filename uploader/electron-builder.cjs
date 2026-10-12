const pkg = require("./package.json");
const repository =
  process.env.RELEASE_REPOSITORY ||
  require("./electron/release-config.json").repository;
const [owner, repo] = repository.split("/");
module.exports = {
  ...pkg.build,
  electronDist: require("node:path").join(
    __dirname,
    "node_modules",
    "electron",
    "dist",
  ),
  publish: [{ provider: "github", owner, repo, releaseType: "release" }],
};
