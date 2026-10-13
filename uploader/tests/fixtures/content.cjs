const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildContent } = require("../../scripts/build-content.cjs");
const appRoot = path.resolve(__dirname, "../..");
async function contentFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fictional-classroom-content-"));
  t.after(async () => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("fictional-classroom-content-")) throw new Error("Invalid fixture cleanup");
    await fsp.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "base");
  const fixtures = {
    "package.json": JSON.stringify({ name: "fictional-content-client", productName: "Fictional", version: "0.1.1", devDependencies: { electron: require("../../package.json").devDependencies.electron } }),
    "electron/main.cjs": "// EXPLICITLY FICTIONAL MAIN\n",
    "electron/preload.cjs": "// EXPLICITLY FICTIONAL PRELOAD\n",
    "electron/core/client.cjs": "module.exports = { fictional: 1 };\n",
    "electron/release-config.json": JSON.stringify({ repository: "fictional-owner/fictional-content" }),
    "electron/assets/icon.png": "EXPLICITLY FICTIONAL ICON",
    "dist/index.html": "<html>EXPLICITLY FICTIONAL INTERFACE</html>",
    "dist/vendor.js": "// EXPLICITLY FICTIONAL UNCHANGED VENDOR\n".repeat(500),
    "dist/removed.txt": "EXPLICITLY FICTIONAL OLD ASSET",
  };
  for (const [name, bytes] of Object.entries(fixtures)) {
    await fsp.mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await fsp.writeFile(path.join(source, name), bytes);
  }
  await fsp.cp(path.join(appRoot, "electron/shell"), path.join(source, "electron/shell"), { recursive: true });
  await fsp.copyFile(path.join(appRoot, "electron/bootstrap.cjs"), path.join(source, "electron/bootstrap.cjs"));
  const options = { repository: "fictional-owner/fictional-content", sourceSha: "a".repeat(40) };
  const initial = await buildContent(source, path.join(root, "initial"), options);
  const nextSource = path.join(root, "next-source");
  await fsp.cp(source, nextSource, { recursive: true });
  await fsp.writeFile(path.join(nextSource, "electron/core/client.cjs"), "module.exports = { fictional: 2 };\n");
  await fsp.unlink(path.join(nextSource, "dist/removed.txt"));
  const output = path.join(root, "next");
  const next = await buildContent(nextSource, output, { ...options, version: "0.1.2" });
  const requests = [];
  const fetcher = async (url, request = {}) => {
    request.signal?.throwIfAborted();
    requests.push(url);
    const name = path.posix.basename(new URL(url).pathname);
    if (!/^content-[a-f0-9]{64}\.br$/.test(name)) throw new Error("Only business content may be downloaded: " + name);
    return new Response(await fsp.readFile(path.join(output, "content", name)));
  };
  return { root, source, initial, next, nextSource, output, requests, fetcher, options };
}
module.exports = { contentFixture };
