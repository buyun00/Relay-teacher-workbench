const { spawn } = require("node:child_process");
const path = require("node:path");
const { expect } = require("@playwright/test");
const assert = require("node:assert/strict");

async function checkOrganization(page, root) {
  page.setDefaultTimeout(20000);
  await new Promise((resolve, reject) => {
    const process = spawn(
      global.process.env.CI
        ? "python"
        : global.process.platform === "win32"
          ? "py"
          : "python3",
      [
        "-X",
        "utf8",
        "-m",
        "tests.organization_fixture",
        path.join(root, "receiver"),
      ],
      {
        cwd: path.resolve(__dirname, "../.."),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    process.stdout.on("data", (c) => (output += c));
    process.stderr.on("data", (c) => (output += c));
    process.once("error", reject);
    process.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(output)),
    );
  });
  await page.getByRole("button", { name: "录音上传", exact: true }).click();
  await page.getByRole("button", { name: "刷新整理记录", exact: true }).click();
  await page.getByRole("button", { name: "开始整理录音", exact: true }).click();
  await expect(page.getByLabel("选择班级")).toHaveValue(""); // No trusted filename time; never use file modification date.
  await page.getByLabel("选择班级").selectOption("fictional-c1");
  await expect(page.locator(".org-selected")).toContainText("教师指定");
  await expect(page.locator(".org-question")).toHaveCount(1);
  await expect(page.locator(".org-question")).toContainText(
    "虚构教师：如何判断函数递增？",
  );
  await page.getByRole("button", { name: "指定说话人", exact: true }).click();
  await page.getByRole("combobox", { name: "搜索学生" }).fill("zm");
  await page
    .getByRole("listbox", { name: "匹配学生" })
    .getByRole("option")
    .click();
  await expect(page.locator(".org-question")).toHaveCount(0);
  await page
    .getByRole("button", { name: "完成此时段并入库", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "已入库", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "课程历史", exact: true }).click();
  await expect(page.locator(".org-history-card")).toContainText(
    "虚构端到端函数课",
  );
  const data = await page.evaluate(() => window.classroom.organization());
  assert.equal(data.activities[0].status, "saved");
  assert.equal(
    data.activities[0].events.filter((e) => e.student_id === "fictional-s1")
      .length,
    1,
  );
  await page.getByRole("button", { name: "查看记录", exact: true }).click();
  await page
    .getByRole("button", { name: "查看全部记录", exact: true })
    .first()
    .click();
  await page
    .locator(".org-question")
    .filter({ hasText: "虚构学生回答" })
    .getByRole("button", { name: /加入右侧对话/ })
    .click();
  await page.getByLabel("教师补充").fill("虚构教师更正：此处讨论任意两点。");
  await page.getByRole("button", { name: "保存补充", exact: true }).click();
  await expect(page.locator(".org-message.teacher")).toContainText("任意两点");
  console.log(
    "Recording organization acceptance passed: real IPC/HTTP/SQLite, contextual questions, pinyin identity selection, confirmation, history and corrections.",
  );
  await page.getByRole('button', {name:'题库与作业'}).click();
  await expect(page.getByText('共 1 题', {exact:true})).toBeVisible();
  await page.getByRole('button').filter({hasText:'虚构端到端：1+1'}).click();
  await expect(page.frameLocator('iframe[title="题干预览"]').locator('body')).toContainText('1+1');
  await page.getByRole('button',{name:'加入选题篮'}).click();
  await page.getByRole('button',{name:'选题篮 · 1'}).click();
  await page.getByLabel('学生',{exact:true}).selectOption('fictional-s1');
  await page.getByLabel('练习目标与安排依据').fill('虚构教师安排的加法练习');
  await page.getByLabel('给学生的提示').fill('用数数的方法');
  await page.getByRole('button',{name:'生成并保存草稿'}).click();
  await expect(page.frameLocator('iframe[title="学生版作业"]').locator('body')).toContainText('用数数的方法');
  await expect(page.frameLocator('iframe[title="学生版作业"]').locator('h3')).toHaveCount(0);
  await page.getByRole('button',{name:'教师版',exact:true}).click();
  await expect(page.frameLocator('iframe[title="教师版作业"]').locator('body')).toContainText('答案');
  const bank = await page.evaluate(() => window.classroom.questionBank({action:'catalog'}));
  assert.equal(bank.papers[0].student_id,'fictional-s1');
  await page.getByRole('button',{name:'关闭预览'}).click();
  console.log('Question bank acceptance passed: real Electron IPC, authenticated HTTP, server SQLite and student/teacher draft separation.');
  return data.activities[0].id;
}
module.exports = { checkOrganization };
