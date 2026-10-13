const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ClassroomClient } = require("../electron/core/client.cjs");

test("multiple arbitrary files and pasted bytes survive restart and source removal without entering the recording queue", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fictional-chat-files-"));
  let client = new ClassroomClient(path.join(root, "client"), { getVolumes: async () => [] });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  const task = client.createTask(), other = client.createTask();
  const source = path.join(root, "fictional.unusual-type"); await fs.writeFile(source, "FICTIONAL REFERENCE 7319");
  const added = await client.chatFiles.add({ id: task.id, files: [{ path: source },
    { filename: "fictional-pasted.png", mime: "image/png", data: Buffer.from("FICTIONAL PNG TRANSPORT BYTES") },
    { filename: "fictional.empty", data: Buffer.alloc(0) }] });
  client.chatFiles.remove({ id: task.id, attachmentId: added[1].id });
  await fs.unlink(source); await client.close();
  client = new ClassroomClient(path.join(root, "client"), { getVolumes: async () => [] });
  const snapshot = client.snapshot();
  assert.equal(snapshot.files.length, 0);
  assert.deepEqual(snapshot.tasks.find(t => t.id === task.id).attachments.map(a => a.id), [added[0].id, added[2].id]);
  assert.equal(snapshot.tasks.find(t => t.id === other.id).attachments.length, 0);
  assert.equal((await fs.readFile((await client.chatFiles.ensure({ id: task.id, attachmentId: added[0].id })).path)).toString(), "FICTIONAL REFERENCE 7319");
  assert.equal(JSON.stringify(snapshot).includes("staged_path"), false);
  assert.equal(JSON.stringify(snapshot.tasks).includes("chat-attachments"), false);
});

test("attachment transfers resume from a durable offset and a lost turn receipt retries the same message and files after restart", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fictional-chat-file-resume-"));
  const uploads = new Map(), turns = [], chunks = [];
  let loseChunk = true, loseTurn = true;
  const fetcher = async (url, options) => {
    const p = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
    if (url.endsWith("/attachments")) {
      uploads.set(p.id, uploads.get(p.id) || { ...p, bytes: p.byte_length, offset: 0, received_at: null });
      return Response.json(uploads.get(p.id));
    }
    const match = /\/attachments\/([^/?]+)(\/complete|\?offset=(\d+))?$/.exec(url);
    if (match) {
      const row = uploads.get(match[1]);
      if (options.method === "PUT") {
        assert.equal(row.offset, Number(match[3])); chunks.push(row.offset); row.offset += p.length;
        if (loseChunk) { loseChunk = false; throw new Error("FICTIONAL lost chunk reply after persisted bytes"); }
      }
      if (match[2] === "/complete") row.received_at ||= "2026-10-13T00:00:00Z";
      return Response.json({ ...row, workspace_id: "fictional" });
    }
    if (url.endsWith("/turns")) {
      assert.ok(p.attachments.every(id => uploads.get(id).received_at)); turns.push(p);
      if (loseTurn) { loseTurn = false; throw new Error("FICTIONAL lost message acceptance"); }
    }
    return Response.json(p || {});
  };
  const make = () => new ClassroomClient(root, { getVolumes: async () => [], fetcher });
  let client = make();
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  client.db.setSetting("endpoint", "http://fictional.invalid"); client.db.setSetting("workspaceId", "fictional");
  const task = client.createTask();
  const [file] = await client.chatFiles.add({ id: task.id, files: [{ filename: "fictional.large", data: Buffer.alloc(3 * 1024 * 1024, 73) }] });
  const message = { id: task.id, content: "", attachments: [file.id] };
  await assert.rejects(client.sendChat(message), /lost chunk/);
  assert.equal(client.snapshot().tasks[0].attachments[0].status, "error");
  await client.close(); client = make();
  await assert.rejects(client.sendChat(message), /lost message/);
  assert.deepEqual(chunks, [0, 2 * 1024 * 1024]);
  await client.close(); client = make();
  await client.sendChat(message);
  assert.equal(turns.length, 2); assert.equal(turns[0].id, turns[1].id);
  assert.deepEqual(turns[0].attachments, turns[1].attachments);
  assert.deepEqual(chunks, [0, 2 * 1024 * 1024]);
  assert.equal(client.snapshot().tasks[0].attachments.length, 0);
  assert.equal(client.snapshot().files.length, 0);
});

test("an accepted older message cannot clear files or text added during its receipt wait", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fictional-chat-file-draft-"));
  const client = new ClassroomClient(root, { getVolumes: async () => [] });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  const task = client.createTask(); client.saveTaskDraft({ id: task.id, draft: "FICTIONAL OLD DRAFT" });
  const [oldFile] = await client.chatFiles.add({ id: task.id, files: [{ filename: "fictional.old", data: Buffer.from("FICTIONAL OLD") }] });
  let reply; client.chat.send = () => new Promise(resolve => { reply = resolve; });
  const sending = client.sendChat({ id: task.id, content: "FICTIONAL OLD DRAFT", attachments: [oldFile.id] });
  client.saveTaskDraft({ id: task.id, draft: "FICTIONAL NEW DRAFT" });
  const [nextFile] = await client.chatFiles.add({ id: task.id, files: [{ filename: "fictional.new", data: Buffer.from("FICTIONAL NEW") }] });
  reply({ id: "fictional-accepted" }); await sending;
  const updated = client.snapshot().tasks.find(t => t.id === task.id);
  assert.equal(updated.draft, "FICTIONAL NEW DRAFT");
  assert.deepEqual(updated.attachments.map(a => a.id), [nextFile.id]);
});
