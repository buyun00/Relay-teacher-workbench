const { test, expect } = require("@playwright/test");

async function fixture(page, update = { state: "current", detail: "虚构最新版本" }) {
  await page.addInitScript(initialUpdate => {
    const snapshot = { mode: "desktop", version: "0.1.1", tasks: [], chatModels: [], deviceState: "ready",
      config: { endpoint: "", workspaceId: "fictional-updates", devices: [], pauseUploads: false,
        hasToken: false, startAtLogin: false, releaseRepo: "fictional-owner/fictional-updates" },
      dataDir: "EXPLICITLY FICTIONAL DATA ONLY", devices: [], candidates: [], files: [], copying: null, scanning: false,
      connection: { state: "online", detail: "虚构连接", checkedAt: null }, update: initialUpdate, logs: [] };
    const listeners = new Set();
    const emit = () => listeners.forEach(fn => fn(structuredClone(snapshot)));
    window.fictionalUpdateChecks = 0;
    window.fictionalUpdateRestarts = 0;
    window.fictionalUpdateInstallError = "";
    window.fictionalUpdateLinks = [];
    window.fictionalSetUpdate = update => { snapshot.update = update; emit(); };
    window.fictionalSetBusy = state => { Object.assign(snapshot, state); emit(); };
    window.classroom = {
      runtimeReady: async () => {}, snapshot: async () => structuredClone(snapshot),
      subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
      subscribeChat: () => () => {}, readChat: async id => ({ chat: { id }, turns: [], events: [], cursor: 0 }),
      checkUpdates: async () => { window.fictionalUpdateChecks++; snapshot.update = { state: "checking", detail: "虚构检查" }; emit(); },
      installUpdate: async () => {
        if (window.fictionalUpdateInstallError) throw new Error(window.fictionalUpdateInstallError);
        window.fictionalUpdateRestarts++;
      },
      openLink: async url => { window.fictionalUpdateLinks.push(url); },
    };
  }, update);
  await page.goto("http://127.0.0.1:5178");
  await expect(page.locator(".app-shell")).toBeVisible();
}

test("updates appear across the full workspace below the title bar and restart from either page without settings", async ({ page }, testInfo) => {
  await fixture(page);
  const banner = page.getByRole("region", { name: "客户端更新" });
  await expect(banner).toHaveCount(0);
  await page.evaluate(() => window.fictionalSetUpdate({ state: "available", version: "0.1.2", detail: "虚构发现新版" }));
  await expect(banner).toContainText("发现新版本 0.1.2");
  await expect(banner).toContainText("正在自动下载");
  await page.evaluate(() => window.fictionalSetUpdate({ state: "downloading", version: "0.1.2", progress: 42, detail: "虚构下载" }));
  await expect(banner.getByRole("progressbar", { name: "更新下载进度" })).toHaveAttribute("value", "42");
  await expect(banner.getByRole("button")).toHaveCount(0);
  await page.evaluate(() => window.fictionalSetUpdate({ state: "downloaded", version: "0.1.2", readyVersion: "0.1.2", detail: "虚构已就绪" }));
  for (const size of [{ width: 1280, height: 860 }, { width: 980, height: 680 }]) {
    await page.setViewportSize(size);
    const title = await page.getByRole("banner", { name: "窗口标题栏" }).boundingBox();
    const ribbon = await banner.boundingBox(), workspace = await page.locator(".app-shell").boundingBox();
    expect(ribbon.x).toBe(0); expect(ribbon.width).toBe(size.width);
    expect(ribbon.y).toBeCloseTo(title.height);
    expect(workspace.y).toBeCloseTo(ribbon.y + ribbon.height);
    expect(workspace.y + workspace.height).toBeCloseTo(size.height);
    await expect(page.getByLabel("消息草稿")).toBeVisible();
    await expect(banner.getByRole("button", { name: "重启并更新" })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath(`update-banner-ready-${size.width}.png`) });
  }
  await page.getByRole("button", { name: "录音上传", exact: true }).click();
  await expect(banner).toContainText("新版本 0.1.2 已下载");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await banner.getByRole("button", { name: "重启并更新" }).click();
  await expect.poll(() => page.evaluate(() => window.fictionalUpdateRestarts)).toBe(1);
  expect(await page.evaluate(() => window.fictionalUpdateChecks)).toBe(0);
});

test("ready updates remain visible during rechecks and failures, and restart waits for copying or background replies", async ({ page }) => {
  await fixture(page, { state: "checking", readyVersion: "0.1.2", detail: "虚构后台检查" });
  const banner = page.getByRole("region", { name: "客户端更新" });
  const restart = banner.getByRole("button", { name: "重启并更新" });
  await expect(restart).toBeEnabled();
  await page.evaluate(() => window.fictionalSetUpdate({ state: "error", readyVersion: "0.1.2", detail: "虚构网络断线" }));
  await expect(restart).toBeEnabled();
  await page.evaluate(() => window.fictionalSetBusy({ copying: { filename: "fictional.wav", bytes: 10, copied: 3, deviceId: "fictional" } }));
  await expect(restart).toBeDisabled();
  await expect(banner).toContainText("正在保存录音");
  await page.evaluate(() => window.fictionalSetBusy({ copying: null, scanning: true }));
  await expect(restart).toBeDisabled();
  await page.evaluate(() => window.fictionalSetBusy({ scanning: false, tasks: [{ id: "fictional-background", title: "虚构后台任务", draft: "", state: "running" }] }));
  await expect(restart).toBeDisabled();
  await expect(banner).toContainText("正在回复");
  await page.evaluate(() => window.fictionalSetBusy({ tasks: [] }));
  await expect(restart).toBeEnabled();
  await page.evaluate(() => { window.fictionalUpdateInstallError = "虚构重启暂时失败"; });
  await restart.click();
  await expect(page.getByRole("alert")).toContainText("虚构重启暂时失败");
  await expect(restart).toBeEnabled();
});

test("failed updates retry from the banner and network restoration triggers a check without opening settings", async ({ page }) => {
  await fixture(page, { state: "error", detail: "虚构断线" });
  const banner = page.getByRole("region", { name: "客户端更新" });
  await banner.getByRole("button", { name: "重试更新" }).click();
  await expect.poll(() => page.evaluate(() => window.fictionalUpdateChecks)).toBe(1);
  await expect(banner).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => page.evaluate(() => window.fictionalUpdateChecks)).toBe(2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("incompatible base upgrades are accessible from the banner", async ({ page }) => {
  await fixture(page, { state: "incompatible", detail: "虚构底座变化" });
  await page.getByRole("region", { name: "客户端更新" }).getByRole("button", { name: "下载新版客户端" }).click();
  await expect.poll(() => page.evaluate(() => window.fictionalUpdateLinks)).toEqual([
    "https://github.com/fictional-owner/fictional-updates/releases/latest",
  ]);
});

test("current versions, local builds and development previews do not display an update prompt", async ({ page }) => {
  await fixture(page);
  for (const state of ["current", "local", "development", "unconfigured", "checking"]) {
    await page.evaluate(state => window.fictionalSetUpdate({ state, detail: "虚构无更新" }), state);
    await expect(page.getByRole("region", { name: "客户端更新" })).toHaveCount(0);
  }
});
