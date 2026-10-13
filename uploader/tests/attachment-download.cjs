const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { once } = require("node:events");

async function checkAttachmentDownload(app, page, profile) {
  // Fictional transport bytes only; this tests opening IPC, not PPT rendering.
  const bytes = Buffer.alloc(65536, "EXPLICITLY FICTIONAL PPT DOWNLOAD 7319\n");
  const filename = "fictional-connection-close.pptx", attachmentId = "att_fictional_close";
  const target = path.join(profile, "chat-attachments", attachmentId, filename);
  let contentRequests = 0, incomplete = false;
  const server = http.createServer((request, response) => {
    response.setHeader("Connection", "close");
    response.setHeader("Cache-Control", "no-store");
    if (request.url.endsWith("/content")) {
      contentRequests++;
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Length", bytes.length);
      response.end(incomplete ? bytes.subarray(0, 4096) : bytes);
      return;
    }
    response.setHeader("Content-Type", "application/json");
    const value = request.url.includes("/attachments/")
      ? { id: attachmentId, filename, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        bytes: bytes.length, received_at: "2026-01-01T00:00:00Z", workspace_id: "fictional-downloads" }
      : { workspace_id: "fictional-downloads", protocol: 1, chats: [], models: [], status: "ok" };
    response.end(JSON.stringify(value));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = "http://127.0.0.1:" + server.address().port;
  const settings = (await page.evaluate(() => window.classroom.snapshot())).config;
  try {
    await app.evaluate(({ net, shell }, endpoint) => {
      const fetch = net.fetch, open = shell.openPath;
      globalThis.downloadCheck = { opened: [], network: [], errors: [] };
      const errors = error => globalThis.downloadCheck.errors.push(error.stack || String(error));
      process.on("uncaughtException", errors);
      net.fetch = async (...args) => {
        const response = await fetch(...args);
        if (args[0].startsWith(endpoint)) {
          globalThis.downloadCheck.network.push(args[0]);
          // Leave the response unread beyond socket close, reproducing the
          // paused-parser condition without slowing or buffering production code.
          if (args[0].endsWith("/content")) await new Promise(resolve => setTimeout(resolve, 150));
        }
        return response;
      };
      shell.openPath = async filename => { globalThis.downloadCheck.opened.push(filename); return ""; };
      globalThis.restoreDownloadCheck = () => {
        net.fetch = fetch; shell.openPath = open;
        process.removeListener("uncaughtException", errors);
      };
    }, endpoint);
    await page.evaluate(endpoint => window.classroom.saveSettings({ endpoint, workspaceId: "fictional-downloads" }), endpoint);
    const task = await page.evaluate(() => window.classroom.createTask());
    const input = { id: task.id, attachmentId };
    await page.evaluate(input => window.classroom.openChatAttachment(input), input);
    assert.deepEqual(await fs.readFile(target), bytes);
    await page.evaluate(input => window.classroom.openChatAttachment(input), input);
    assert.equal(contentRequests, 1, "A repeated open must reuse the completed local copy");
    assert.deepEqual(await app.evaluate(() => globalThis.downloadCheck.opened), [target, target]);
    assert.deepEqual(await app.evaluate(() => globalThis.downloadCheck.errors), []);
    assert.equal((await app.evaluate(() => globalThis.downloadCheck.network)).filter(url => url.endsWith("/content")).length, 1,
      "Attachment HTTP must use Electron networking, avoiding Node's bundled Undici");

    await fs.unlink(target);
    incomplete = true;
    await assert.rejects(() => page.evaluate(input => window.classroom.openChatAttachment(input), input));
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
    assert.deepEqual(await fs.readdir(path.dirname(target)), [], "A partial download must not remain as a cached file");
    assert.deepEqual(await app.evaluate(() => globalThis.downloadCheck.opened), [target, target], "Never open a partial file");
    incomplete = false;
    await page.evaluate(input => window.classroom.openChatAttachment(input), input);
    assert.deepEqual(await fs.readFile(target), bytes);
    assert.equal(contentRequests, 3);
    assert.deepEqual(await app.evaluate(() => globalThis.downloadCheck.opened), [target, target, target]);
    assert.deepEqual(await app.evaluate(() => globalThis.downloadCheck.errors), []);
    console.log("Attachment download acceptance passed: peer closes while body is unread, repeated open uses cache, partial download is rejected and retry succeeds.");
  } finally {
    await app.evaluate(() => globalThis.restoreDownloadCheck?.()).catch(() => {});
    await page.evaluate(settings => window.classroom.saveSettings({ endpoint: settings.endpoint, workspaceId: settings.workspaceId }), settings).catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

module.exports = { checkAttachmentDownload };
