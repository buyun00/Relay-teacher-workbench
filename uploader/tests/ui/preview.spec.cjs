const { test, expect } = require("@playwright/test");

test("generated files appear inside the assistant reply and save from that same conversation", async ({ page }) => {
  await page.addInitScript(() => {
    const stamp = '2026-10-13T00:00:00Z';
    const task = { id: 'fictional-result-chat', title: '虚构成品验收', draft: '', createdAt: stamp, updatedAt: stamp };
    const files = [
      { id: 'fictional-result-image', filename: 'fictional-generated.png', mime: 'image/png', bytes: 7319 },
      { id: 'fictional-result-video', filename: 'fictional-generated.mp4', mime: 'video/mp4', bytes: 7319 },
    ];
    window.fictionalSaves = [];
    window.fictionalOpens = [];
    const snapshot = { mode: 'preview', version: '0.1.0', tasks: [task], chatModels: [], deviceState: 'ready',
      config: { endpoint: '', workspaceId: 'fictional-delivery', devices: [], pauseUploads: false, hasToken: false },
      dataDir: 'FICTIONAL DATA ONLY', devices: [], candidates: [], files: [], copying: null, scanning: false,
      connection: { state: 'online', detail: '虚构连接', checkedAt: stamp }, update: { state: 'local', detail: '虚构本地包' }, logs: [] };
    const view = { chat: { id: task.id, title: task.title, route_state: 'locked', model_id: null },
      turns: [{ id: 'fictional-result-turn', chat_id: task.id, content: '制作虚构文件', answer: '成品已附在这条回复中。',
        state: 'completed', error: null, created_at: stamp, attachments: [], outputs: files }], events: [], cursor: 1, workspace_id: 'fictional-delivery' };
    window.classroom = {
      runtimeReady: async () => {},
      snapshot: async () => snapshot, subscribe: () => () => {}, readChat: async () => view, subscribeChat: () => () => {},
      previewChatAttachment: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB8sAAAAASUVORK5CYII=',
      saveChatAttachment: async input => { window.fictionalSaves.push(input); },
      openChatAttachment: async input => { window.fictionalOpens.push(input); },
    };
  });
  await page.goto('http://127.0.0.1:5178');
  const results = page.getByLabel('生成的成品');
  await expect(results.locator('.chat-attachment')).toHaveCount(2);
  await expect(page.locator('.assistant-message')).toContainText('fictional-generated.mp4');
  await expect(page.locator('.user-message .chat-attachment')).toHaveCount(0);
  await results.getByRole('button', { name: '预览图片：fictional-generated.png' }).click();
  await expect(page.getByRole('dialog', { name: '图片预览：fictional-generated.png' })).toBeVisible();
  await page.getByRole('button', { name: '关闭图片预览' }).click();
  await results.getByRole('button', { name: '打开附件：fictional-generated.mp4', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.fictionalOpens)).toEqual([
    { id: 'fictional-result-chat', attachmentId: 'fictional-result-video' },
  ]);
  await expect.poll(() => page.evaluate(() => window.fictionalSaves)).toEqual([]);
  await results.getByRole('button', { name: '保存附件：fictional-generated.mp4' }).click();
  await expect.poll(() => page.evaluate(() => window.fictionalSaves)).toEqual([
    { id: 'fictional-result-chat', attachmentId: 'fictional-result-video' },
  ]);
});

test("integrated title bar and workspace fit normal and minimum window sizes", async ({ page }) => {
  await page.goto("http://127.0.0.1:5178");
  for (const size of [{ width: 1280, height: 860 }, { width: 980, height: 680 }]) {
    await page.setViewportSize(size);
    const header = page.getByRole("banner", { name: "窗口标题栏" });
    await expect(header).toContainText("课堂连接");
    await expect(page.locator(".sidebar .app-name")).toHaveCount(0);
    const title = await header.boundingBox(), workspace = await page.locator(".app-shell").boundingBox();
    expect(title.y).toBe(0);
    expect(title.width).toBe(size.width);
    expect(workspace.y).toBeCloseTo(title.height);
    expect(workspace.y + workspace.height).toBeCloseTo(size.height);
    const hero = await page.locator(".conversation-empty").boundingBox();
    const area = await page.locator(".conversation").boundingBox();
    expect(Math.abs(hero.x + hero.width / 2 - area.x - area.width / 2)).toBeLessThan(2);
    await expect(page.getByLabel("消息草稿")).toBeVisible();
    await expect(page.getByRole("button", { name: "设置", exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByRole("combobox", { name: "对话模型" }).click();
  await expect(page.getByRole("listbox", { name: "选择对话模型" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "录音上传", exact: true }).click();
  await expect(page.getByRole("button", { name: "手动上传", exact: true })).toBeVisible();
});

test("multi-file messages preview and remove images, preserve attachments across tasks, and send attachments without text", async ({ page }) => {
  await page.goto("http://127.0.0.1:5178");
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const task = page.locator("[data-chat-id]").first(); const id = await task.getAttribute("data-chat-id");
  const chooser = page.waitForEvent("filechooser"); await page.getByRole("button", { name: "添加附件", exact: true }).click();
  await (await chooser).setFiles([
    { name: "fictional-reference.txt", mimeType: "text/plain", buffer: Buffer.from("FICTIONAL REFERENCE 7319") },
    { name: "fictional-picture.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB8sAAAAASUVORK5CYII=", "base64") },
    { name: "fictional-anything.custom", mimeType: "application/octet-stream", buffer: Buffer.from("FICTIONAL ARBITRARY TYPE") },
  ]);
  const drafts = page.getByLabel("待发送附件");
  await expect(drafts.locator(".chat-attachment")).toHaveCount(3);
  await expect(drafts.getByRole("img")).toBeVisible();
  await drafts.getByRole("button", { name: "预览图片：fictional-picture.png" }).click();
  await expect(page.getByRole("dialog", { name: "图片预览：fictional-picture.png" })).toBeVisible();
  await page.getByRole("button", { name: "关闭图片预览" }).press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await drafts.getByRole("button", { name: "移除附件：fictional-anything.custom" }).click();
  await expect(drafts.locator(".chat-attachment")).toHaveCount(2);
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await expect(page.getByLabel("待发送附件")).toHaveCount(0);
  await page.locator(`[data-chat-id="${id}"] .task-item`).click();
  await expect(page.getByLabel("待发送附件").locator(".chat-attachment")).toHaveCount(2);
  await expect(page.getByLabel("消息草稿")).toHaveValue("");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByLabel("待发送附件")).toHaveCount(0);
  await expect(page.getByLabel("消息附件").locator(".chat-attachment")).toHaveCount(2);
  await expect(page.getByLabel("消息附件").getByRole("button", { name: "保存附件：fictional-reference.txt" })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
});

test("dragged files and pasted clipboard images accompany one text message", async ({ page }) => {
  await page.goto("http://127.0.0.1:5178");
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.locator(".chat-view").evaluate(el => {
    const transfer = new DataTransfer(); transfer.items.add(new File(["FICTIONAL PDF BYTES"], "fictional-drop.pdf", { type: "application/pdf" }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.getByLabel("待发送附件").locator(".chat-attachment")).toHaveCount(1);
  await page.getByLabel("消息草稿").evaluate(el => {
    const transfer = new DataTransfer();
    const raw = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB8sAAAAASUVORK5CYII="), c => c.charCodeAt(0));
    transfer.items.add(new File([raw], "fictional-paste.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await expect(page.getByLabel("待发送附件").locator(".chat-attachment")).toHaveCount(2);
  await page.getByLabel("消息草稿").fill("虚构需求：读取这两个附件");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.locator(".user-message")).toContainText("虚构需求：读取这两个附件");
  await expect(page.getByLabel("消息附件").locator(".chat-attachment")).toHaveCount(2);
});

test("two-pane conversation streams, routes after early turns, shows steps, and supports stop", async ({ page }) => {
  await page.goto("http://127.0.0.1:5178");
  await expect(page.getByText("浏览器预览 · 虚构数据")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "消息草稿" })).toBeDisabled();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByRole("textbox", { name: "消息草稿" }).fill("虚构任务：整理课堂录音");
  await expect(page.getByRole("navigation", { name: "任务列表" })).toContainText("虚构任务：整理课堂录音");
  await expect(page.getByText(/草稿已保存在本机|正在保存草稿/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送消息" })).toBeEnabled();
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
  await expect(page.getByLabel("AI 回复")).toContainText("虚构回复");
  await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible({ timeout: 10000 });
  await page.getByRole("textbox", { name: "消息草稿" }).fill("虚构高一数学备课，解释对数函数");
  await page.getByRole("textbox", { name: "消息草稿" }).press("Enter");
  await expect(page.getByRole("combobox", { name: "对话模型" })).toContainText("GPT-6 Astra");
  await expect(page.getByText("执行步骤 · 0/1")).toBeVisible();
  await page.getByRole("button", { name: "停止回复" }).click();
  await expect(page.getByText("已停止", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await expect(page.getByLabel("AI 回复")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "设备管理", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "工作台", exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("爱马仕");
});

test("recording page unifies device, progress and expanded files with manual multi-file entry", async ({ page }) => {
  await page.goto("http://127.0.0.1:5178");
  await page.getByRole("button", { name: "录音上传", exact: true }).click();
  const panel = page.locator(".org-queue");
  await expect(panel).toContainText("录音设备已连接");
  await expect(page.getByRole("progressbar",{name:"上传进度"})).toBeVisible();
  await expect(page.getByRole("progressbar",{name:"转写与活动识别"})).toBeVisible();
  await expect(page.locator(".org-file")).toHaveCount(6);
  await page.getByRole("button", { name: "手动上传", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("新增 1 份录音");
  await expect(page.locator(".org-file").filter({hasText:"虚构_手动上传_100.wav"})).toContainText("等待上传");
  await page.getByRole("button", { name: "暂停上传", exact: true }).click();
  await expect(page.getByRole("button", { name: "继续上传", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续上传", exact: true }).click();
  await expect(panel).toContainText("正在上传");
});

test("glass model picker supports mouse and keyboard selection, dismissal and conversation locks", async ({ page }) => {
  await page.goto("http://127.0.0.1:5178");
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const picker = page.getByRole("combobox", { name: "对话模型" });
  const menu = page.getByRole("listbox", { name: "选择对话模型" });
  await expect(picker).toBeEnabled();
  await picker.click();
  await expect(menu.getByRole("option")).toHaveCount(5);
  await expect(menu.getByRole("option", { name: /自动/ })).toHaveAttribute("aria-selected", "true");
  await menu.getByRole("option", { name: /GPT-6 Astra/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(picker).toContainText("GPT-6 Astra");
  await expect(picker).toBeFocused();
  await picker.click();
  await expect(menu.getByRole("option", { name: /GPT-6 Astra/ })).toHaveAttribute("aria-selected", "true");
  await picker.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(picker).toContainText("GPT-6 Astra");
  await picker.click();
  await page.getByLabel("消息草稿").click();
  await expect(menu).toHaveCount(0);
  await picker.focus();
  await picker.press("ArrowDown");
  await picker.press("Home");
  await picker.press("End");
  await picker.press("ArrowUp");
  await picker.press("Enter");
  await expect(picker).toContainText("GPT-6 Sol");
  await picker.press("ArrowDown");
  await picker.press("ArrowUp");
  await picker.press("Tab");
  await expect(menu).toHaveCount(0);
  await expect(picker).toContainText("GPT-6 Sol");
  await picker.click();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(picker).toContainText("自动");
  await page.getByLabel("消息草稿").fill("虚构测试：整理一段课堂提纲");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
  await expect(picker).toBeDisabled();
  await expect(picker).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "停止回复" }).click();
  await expect(picker).toBeEnabled();
  await page.locator(".task-row.selected .task-action").click();
  await page.getByRole("button", { name: "已归档对话", exact: true }).click();
  await expect(picker).toBeDisabled();
  await expect(menu).toHaveCount(0);
});

test("welcome is centered and named conversations can be archived and restored with their draft", async ({ page }) => {
  await page.goto("http://127.0.0.1:5178");
  const hero = await page.locator('.conversation-empty').boundingBox();
  const area = await page.locator('.conversation').boundingBox();
  expect(Math.abs(hero.x + hero.width / 2 - area.x - area.width / 2)).toBeLessThan(2);
  expect(Math.abs(hero.y + hero.height / 2 - area.y - area.height / 2)).toBeLessThan(2);
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByLabel('消息草稿').fill('虚构问候：在吗');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible({timeout:10000});
  await page.getByLabel('消息草稿').fill('虚构高一数学：制作对数函数教学提纲');
  await page.getByLabel('消息草稿').press('Enter');
  await expect(page.getByRole('navigation', {name:'任务列表'})).toContainText('对数函数教学备课');
  await page.getByRole('button', {name:'停止回复',exact:true}).click();
  await page.getByLabel('消息草稿').fill('虚构未发送草稿，应随对话保留');
  await page.getByRole('button', {name:'归档对话：对数函数教学备课',exact:true}).click();
  await expect(page.getByRole('navigation', {name:'任务列表'})).not.toContainText('对数函数教学备课');
  await page.getByRole('button', {name:'已归档对话',exact:true}).click();
  await expect(page.getByRole('navigation', {name:'任务列表'})).toContainText('对数函数教学备课');
  await expect(page.getByLabel('消息草稿')).toBeDisabled();
  await page.getByRole('button', {name:'恢复对话：对数函数教学备课',exact:true}).click();
  await expect(page.getByLabel('消息草稿')).toHaveValue('虚构未发送草稿，应随对话保留');
  await expect(page.locator('.chat-turn')).toHaveCount(2);
  await expect(page.getByText('已停止',{exact:true})).toBeVisible();
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
