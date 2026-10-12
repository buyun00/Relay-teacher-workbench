const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { ClassroomClient } = require("../electron/core/client.cjs");

test("local task drafts survive restart independently of the recording queue and never become a sent reply", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fictional-classroom-drafts-"));
  let client = new ClassroomClient(path.join(root, "client"), { getVolumes: async () => [] });
  t.after(async () => { await client.close(); await fsp.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, "fictional-manual.wav");
  await fsp.writeFile(file, "FICTIONAL QUEUED RECORDING, NEVER SUBMITTED TO ASR");
  await client.addFiles([file]);
  client.pause(true);
  const first = client.createTask();
  const second = client.createTask();
  const draft = "虚构任务草稿：整理课堂录音\n尚未发送到任何对话服务。";
  client.saveTaskDraft({ id: first.id, draft });
  await client.archiveTask({ id: first.id, archived: true });
  assert.throws(() => client.saveTaskDraft({ id: "fictional-unknown-task", draft }), /不存在/);
  await client.close();
  client = new ClassroomClient(path.join(root, "client"), { getVolumes: async () => [] });
  const state = client.snapshot();
  assert.equal(state.tasks.find((task) => task.id === first.id).draft, draft);
  assert.ok(state.tasks.find((task) => task.id === first.id).archived_at);
  await client.archiveTask({ id: first.id, archived: false });
  assert.equal(client.snapshot().tasks.find((task) => task.id === first.id).archived_at, null);
  assert.equal(state.tasks.find((task) => task.id === second.id).draft, "");
  assert.equal(state.files.length, 1);
  assert.equal(state.files[0].state, "queued");
  assert.equal(state.config.pauseUploads, true);
  assert.equal(state.tasks.some((task) => "messages" in task || "completed" in task), false);
});

test("archiving during a network wait preserves newer drafts and other newly created tasks", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fictional-classroom-archive-draft-"));
  let client = new ClassroomClient(root, { getVolumes: async () => [] });
  t.after(async () => { await client.close(); await fsp.rm(root, { recursive: true, force: true }); });
  client.db.setSetting("endpoint", "http://127.0.0.1:8766");
  const first = client.createTask();
  client.saveTaskDraft({ id: first.id, draft: "虚构旧草稿" });
  let reply;
  client.chat.archive = () => new Promise((resolve) => { reply = resolve; });
  const pending = client.archiveTask({ id: first.id, archived: true });
  client.saveTaskDraft({ id: first.id, draft: "虚构的新草稿，必须保留" });
  const second = client.createTask();
  client.saveTaskDraft({ id: second.id, draft: "虚构的另一段对话" });
  reply({ chat: { archived_at: "2026-01-01T00:00:00Z" } });
  await pending;
  await client.close();
  client = new ClassroomClient(root, { getVolumes: async () => [] });
  const state = client.snapshot();
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks.find((task) => task.id === first.id).draft, "虚构的新草稿，必须保留");
  assert.ok(state.tasks.find((task) => task.id === first.id).archived_at);
  assert.equal(state.tasks.find((task) => task.id === second.id).draft, "虚构的另一段对话");
});

test("invalid settings leave the previous receiver and workspace intact", async (t) => {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), "fictional-classroom-settings-"),
  );
  const client = new ClassroomClient(root, { getVolumes: async () => [] });
  t.after(async () => {
    await client.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  client.saveSettings({
    endpoint: "http://127.0.0.1:8766",
    workspaceId: "fictional-original",
  });
  assert.throws(() =>
    client.saveSettings({
      endpoint: "http://127.0.0.1:9999",
      workspaceId: "",
      releaseRepo: "invalid",
    }),
  );
  assert.equal(client.config().endpoint, "http://127.0.0.1:8766");
  assert.equal(client.config().workspaceId, "fictional-original");
});

test("moving encrypted credentials to an incompatible system requires correction rather than silent retries", async (t) => {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), "fictional-classroom-credential-"),
  );
  const client = new ClassroomClient(root, {
    getVolumes: async () => [],
    codec: {
      decrypt() {
        throw new Error("FICTIONAL DPAPI failure");
      },
    },
  });
  t.after(async () => {
    await client.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  client.db.setSetting("tokenEncrypted", "FICTIONAL CIPHERTEXT");
  assert.throws(
    () => client.token(),
    (error) => error.retryable === false && /重新填写/.test(error.message),
  );
  assert.equal(
    JSON.stringify(client.snapshot()).includes("FICTIONAL CIPHERTEXT"),
    false,
  );
});
