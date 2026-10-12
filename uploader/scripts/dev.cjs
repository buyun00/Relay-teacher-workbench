const { spawn } = require("node:child_process");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const vite = spawn(
  process.execPath,
  [path.join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1"],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
let desktop;
const stop = () => {
  desktop?.kill();
  vite.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
(async () => {
  for (let tries = 0; tries < 60; tries++) {
    try {
      const response = await fetch("http://127.0.0.1:5178");
      if (response.ok) break;
    } catch {}
    if (vite.exitCode !== null || tries === 59) {
      stop();
      process.exitCode = 1;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  desktop = spawn(require("electron"), [root], {
    cwd: root,
    env: { ...process.env, CLASSROOM_DEV_URL: "http://127.0.0.1:5178" },
    stdio: "inherit",
    windowsHide: true,
  });
  desktop.on("exit", (code) => {
    vite.kill();
    process.exitCode = code;
  });
})();
