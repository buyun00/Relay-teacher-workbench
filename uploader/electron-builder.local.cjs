const release = require("./electron-builder.cjs");
const pkg = require("./package.json");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// Only the packaged metadata changes; the source version and lockfile stay intact.
module.exports = {
  ...release,
  directories: { ...release.directories, output: "release-local" },
  artifactName: "Hermes-Classroom-Local-${version}-${arch}-Setup.${ext}",
  extraMetadata: {
    version: `${pkg.version}-local.${stamp}`,
    classroomBuild: { channel: "local" },
  },
  // Local installers neither publish nor provide a public update manifest.
  publish: null,
};
