const { test, expect } = require("@playwright/test");

test("browser preview labels fictional data and supports queue controls, filtering and receipt detail", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:5178");
  await expect(page.getByText("浏览器预览 · 虚构数据")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "录音已在本机，可以拔出设备。" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "录音传输" }).click();
  await page.getByRole("button", { name: "暂停上传", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "继续上传", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "需处理", exact: true }).click();
  await expect(page.locator(".file-row")).toHaveCount(1);
  await page.getByRole("button", { name: /重试 虚构录音/ }).click();
  await expect(page.locator(".file-row")).toHaveCount(0);
  await page.getByRole("button", { name: "已入库", exact: true }).click();
  await expect(page.locator(".file-row")).toHaveCount(3);
  await page.getByRole("textbox", { name: "搜索录音文件" }).fill("100000");
  await expect(page.locator(".file-row")).toHaveCount(1);
  await page.locator(".file-identity").click();
  await expect(page.getByRole("dialog")).toContainText("爱马仕持久化回执");
  await expect(page.getByRole("dialog")).toContainText("asset_demo_1");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("settings do not retain a browser credential or claim actual updates", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:5178");
  await page.getByRole("button", { name: "连接与设置" }).click();
  await page
    .getByLabel("连接凭据", { exact: true })
    .fill("fictional-not-a-real-token");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByLabel("连接凭据", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(
    page.getByText("安装后的桌面端会检查公开 GitHub Releases"),
  ).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "fictional-not-a-real-token",
  );
});
