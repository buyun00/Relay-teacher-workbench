const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { QueueDatabase } = require("../electron/core/database.cjs");
const { ChatTransport, applyEvent } = require("../electron/core/chat.cjs");

test("SSE replay deduplicates deltas, preserves tools, and never crosses conversations", () => {
  const view = { chat: { id: "fictional" }, turns: [], events: [], cursor: 0 };
  const event = (seq, kind, payload) => ({ seq, kind, payload, chat_id: "fictional", turn_id: "fictional-turn" });
  applyEvent(view, event(1, "turn", { id: "fictional-turn", content: "虚构消息", answer: "", state: "queued" }));
  const delta = event(2, "delta", { text: "虚构片段" });
  applyEvent(view, delta); applyEvent(view, delta);
  assert.equal(view.turns[0].answer, "虚构片段");
  applyEvent(view, event(3, "tool_start", { id: "fictional-tool", name: "teacher_context" }));
  applyEvent(view, event(4, "done", { answer: "虚构最终答案", state: "completed" }));
  assert.equal(view.turns[0].answer, "虚构最终答案");
  assert.equal(view.events.length, 1);
  assert.throws(() => applyEvent(view, { ...event(5, "delta", {}), chat_id: "fictional-other" }), /不匹配/);
});

test("a lost acceptance reply retries the same durable message identity, including after client restart", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fictional-chat-"));
  const db = new QueueDatabase(root);
  let attempt = 0;
  const ids = [];
  const fetcher = async (_url, options) => {
    const p = JSON.parse(options.body);
    if (_url.endsWith("/turns")) { ids.push(p.id); if (++attempt === 1) throw new Error("FICTIONAL lost response"); }
    return Response.json(p);
  };
  let client = new ChatTransport(db, () => ({ endpoint: "http://fictional.invalid", workspaceId: "fictional" }), () => "", () => {}, () => {}, fetcher);
  t.after(async () => { await client.close(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  await assert.rejects(client.send({ id: "fictional", content: "虚构消息" }));
  await client.close();
  client = new ChatTransport(db, () => ({ endpoint: "http://fictional.invalid", workspaceId: "fictional" }), () => "", () => {}, () => {}, fetcher);
  await client.send({ id: "fictional", content: "虚构消息" });
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});
