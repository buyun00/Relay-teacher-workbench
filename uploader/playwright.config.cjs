const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testDir: "./tests/ui",
  timeout: 30000,
  workers: 1,
  reporter: "list",
  use: {
    headless: true,
    viewport: { width: 1280, height: 860 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5178",
    reuseExistingServer: !process.env.CI,
  },
});
