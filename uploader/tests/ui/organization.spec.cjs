const { test, expect } = require("@playwright/test");

async function review(page) {
  await page.goto("http://127.0.0.1:5178");
  await page.getByRole("button", { name: "录音上传", exact: true }).click();
  await page.getByRole("button", { name: "开始整理录音", exact: true }).click();
}

test("speaker search filters each keystroke, pinyin, initials, surname and Chinese, never cross-class", async ({
  page,
}) => {
  await review(page);
  await expect(page.getByLabel("选择班级")).toHaveValue("fictional-class3");
  await expect(page.locator(".org-question")).toContainText("约 08:26");
  await expect(page.locator(".org-question")).toContainText("怎样判断函数");
  await expect(page.locator(".org-question")).toHaveCount(1);
  await page.getByRole("button", { name: "指定说话人", exact: true }).click();
  const input = page.getByRole("combobox", { name: "搜索学生" });
  await expect(input).toBeFocused();
  await input.pressSequentially("z");
  await expect(
    page.getByRole("listbox", { name: "匹配学生" }).getByRole("option"),
  ).toHaveCount(1);
  await input.pressSequentially("m");
  await expect(
    page.getByRole("listbox", { name: "匹配学生" }).getByRole("option"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("listbox", { name: "匹配学生" }).getByRole("option"),
  ).toContainText("fictional-student-a");
  await input.fill("zhangming");
  await expect(
    page.getByRole("listbox", { name: "匹配学生" }).getByRole("option"),
  ).toHaveCount(1);
  await input.fill("shan");
  await expect(
    page.getByRole("listbox", { name: "匹配学生" }).getByRole("option"),
  ).toContainText("单宇");
  await input.fill("李");
  await expect(
    page.getByRole("listbox", { name: "匹配学生" }).getByRole("option"),
  ).toContainText("李华");
  await input.fill("不存在");
  await expect(
    page.getByText("没有匹配的学生，请检查班级或姓名。"),
  ).toBeVisible();
  await input.fill("zm");
  await input.press("Enter");
  await expect(page.locator(".org-question")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "完成此时段并入库" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "完成此时段并入库" }).click();
  await page.getByRole("button", { name: "课程历史", exact: true }).click();
  await expect(page.locator(".org-history-day")).toHaveCount(2);
  await expect(page.locator(".org-history-day").first()).toContainText(
    "2026年10月13日",
  );
  const older = page.locator(".org-history-day").last();
  await expect(older.locator("article").first()).toContainText("第一节课");
  await expect(older.locator("article").last()).toContainText("第二节课");
  await page.reload();
  await page.getByRole("button", { name: "课程历史", exact: true }).click();
  await expect(page.locator(".org-history-day")).toHaveCount(2);
});

test("unknown stays unknown, teacher notes save to one fragment and remain editable from history", async ({
  page,
}) => {
  await review(page);
  await page
    .getByLabel("教师补充")
    .fill("虚构补充：当时正在讨论任意两点的条件。");
  await page.getByRole("button", { name: "保存补充", exact: true }).click();
  await expect(page.locator(".org-message.teacher")).toContainText("任意两点");
  await expect(page.locator(".org-question")).toHaveCount(0);
  await page
    .getByRole("button", { name: "查看全部记录", exact: true })
    .first()
    .click();
  await expect(page.locator(".org-question")).toContainText("任意两点");
  await expect(
    page.getByRole("button", { name: "指定说话人", exact: true }),
  ).toHaveText("指定说话人");
  await page.getByRole("button", { name: "完成此时段并入库" }).click();
  await page.getByRole("button", { name: "课程历史", exact: true }).click();
  await page
    .locator(".org-history-day")
    .first()
    .getByRole("button", { name: "查看记录" })
    .click();
  await page.getByLabel("教师补充").fill("虚构更正：确认是讨论任意两点。");
  await page.getByRole("button", { name: "保存补充", exact: true }).click();
  await expect(page.locator(".org-message.teacher")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "已入库", exact: true }),
  ).toBeDisabled();
});

test("minimum desktop viewport keeps confirmation and search accessible without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 980, height: 680 });
  await review(page);
  await page.getByRole("button", { name: "指定说话人", exact: true }).click();
  await page.getByRole("combobox", { name: "搜索学生" }).fill("lh");
  await page
    .getByRole("listbox", { name: "匹配学生" })
    .getByRole("option")
    .click();
  await page.getByRole("button", { name: "完成此时段并入库" }).click();
  await expect(
    page.getByRole("button", { name: "已入库", exact: true }),
  ).toBeDisabled();
  const sizes = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(sizes.width).toBe(sizes.viewport);
});
