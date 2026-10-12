const { test, expect } = require("@playwright/test");

test("two-pane tasks support local drafts while the conversation service remains explicitly pending", async ({ page }) => {
  await page.goto("http://127.0.0.1:5178");
  await expect(page.getByText("浏览器预览 · 虚构数据")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息草稿" })).toBeDisabled();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByRole("textbox", { name: "消息草稿" }).fill("虚构任务：整理课堂录音");
  await expect(page.getByRole("navigation", { name: "任务列表" })).toContainText("虚构任务：整理课堂录音");
  await expect(page.getByText("草稿已保存在本机")).toBeVisible();
  await expect(page.getByRole("button", { name: "发送消息" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "对话功能将在下一步接入" })).toBeVisible();
  await expect(page.getByRole("button", { name: "设备管理", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "工作台", exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("爱马仕");
});

test("recording page shows device, pending files and upload status with manual multi-file entry", async ({ page }) => {
  await page.goto("http://127.0.0.1:5178");
  await page.getByRole("button", { name: "录音上传", exact: true }).click();
  const panel = page.getByRole("region", { name: "录音上传状态" });
  await expect(panel).toContainText("录音设备");
  await expect(panel).toContainText("已接入");
  await expect(panel).toContainText("待上传录音");
  await expect(panel).toContainText("上传状态");
  await page.getByRole("button", { name: "手动上传", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("新增 1 份录音");
  await page.locator("summary").filter({ hasText: "录音文件" }).click();
  const manual = page.locator(".file-row").filter({ hasText: "虚构_手动上传_100.wav" });
  await expect(manual).toContainText("手动上传");
  await expect(manual).toContainText("等待上传");
  await page.getByRole("button", { name: "暂停上传", exact: true }).click();
  await expect(panel).toContainText("已暂停");
  await page.getByRole("button", { name: "继续上传", exact: true }).click();
  await expect(panel).toContainText("正在上传");
});

test("settings stay in a dialog, keep browser credentials out of storage and use one Hremes reference", async ({ page }) => {
  await page.goto("http://127.0.0.1:5178");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Hremes");
  await page.getByLabel("连接凭据", { exact: true }).fill("fictional-not-a-real-token");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByLabel("连接凭据", { exact: true })).toHaveValue("");
  await page.getByText("更多设置", { exact: true }).click();
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.getByText("安装后的桌面端会检查公开 GitHub Releases")).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("fictional-not-a-real-token");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("saved recording reports open inside the upload page without adding a navigation page", async ({ page }) => {
  await page.goto("http://127.0.0.1:5178");
  await page.getByRole("button", { name: "录音上传", exact: true }).click();
  await page.locator(".file-details summary").click();
  await expect(page.locator(".file-row").filter({ hasText: "虚构录音_20261012_100000.wav" })).toContainText("处理完成");
  await page.getByRole("button", { name: "查看结果", exact: true }).click();
  const result = page.getByRole("dialog", { name: "录音处理结果" });
  await expect(result).toContainText("虚构复盘示例");
  await expect(result).toContainText("虚构备课示例");
  await page.keyboard.press("Escape");
  await expect(result).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "录音上传", exact: true })).toBeVisible();
});
