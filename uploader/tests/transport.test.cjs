const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { QueueDatabase } = require("../electron/core/database.cjs");
const { Transport, verifyReceipt } = require("../electron/core/transport.cjs");

async function receiver(t, root) {
  const command = process.env.CI
    ? "python"
    : process.platform === "win32"
      ? "py"
      : "python3";
  const child = spawn(
    command,
    [
      "-X",
      "utf8",
      "-m",
      "workbench.ingress",
      "--root",
      path.join(root, "receiver"),
      "--port",
      "0",
    ],
    {
      cwd: path.resolve(__dirname, "../.."),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HERMES_HOME: path.join(root, "fictional-hermes-home"),
        HERMES_UPLOADER_TOKEN: "",
      },
      windowsHide: true,
    },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  t.receiverChild = child;
  const info = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Receiver did not start: " + errors)),
      10000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(output.split("\n")[0]));
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Receiver exited: " + errors));
    });
  });
  return { child, endpoint: "http://127.0.0.1:" + info.listen[1] };
}
async function fixture(t) {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), "fictional-classroom-transport-"),
  );
  // These bytes are deliberately fictional and are never submitted to ASR.
  const content = Buffer.alloc(5 * 1024 * 1024 + 113, 70);
  const sha = crypto.createHash("sha256").update(content).digest("hex");
  const db = new QueueDatabase(path.join(root, "client"));
  const stagedPath = path.join(db.staging, sha + ".audio");
  await fsp.writeFile(stagedPath, content);
  const row = db.registerFile(
    {
      id: "file_" + sha,
      sha256: sha,
      filename: "fictional-recording.wav",
      bytes: content.length,
      stagedPath,
      modifiedAt: new Date().toISOString(),
    },
    {
      deviceId: "fictional-volume",
      relativePath: "fictional-recording.wav",
      name: "虚构设备",
      mtimeMs: 123,
    },
  );
  // Stop the server before removing its files, including on Windows.
  t.after(async () => {
    if (t.receiverChild && t.receiverChild.exitCode === null) {
      t.receiverChild.kill();
      await once(t.receiverChild, "exit");
    }
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, content, db, row };
}

test("mismatched or incomplete receipt never confirms local receipt state", () => {
  const file = { sha256: "a".repeat(64), bytes: 123 };
  const receipt = {
    sha256: file.sha256,
    byte_length: 123,
    workspace_id: "teacher",
    upload_id: "up_" + file.sha256,
    asset_id: "asset_abc",
    received_at: new Date().toISOString(),
  };
  assert.equal(
    verifyReceipt(receipt, file, "teacher", receipt.upload_id),
    receipt,
  );
  for (const patch of [
    { sha256: "b".repeat(64) },
    { byte_length: 124 },
    { workspace_id: "other" },
    { upload_id: "up_other" },
    { received_at: "" },
  ]) {
    assert.throws(
      () =>
        verifyReceipt(
          { ...receipt, ...patch },
          file,
          "teacher",
          receipt.upload_id,
        ),
      /回执不匹配/,
    );
  }
});

test("interrupted upload resumes at durable offset, uses the local copy after device removal, and queries status without audio", async (t) => {
  const { root, content, db, row } = await fixture(t);
  const { endpoint } = await receiver(t, root);
  const config = {
    endpoint,
    workspaceId: "teacher",
    clientId: "fictional-client",
    pauseUploads: false,
  };
  let interrupted = false;
  const offsets = [];
  const fetcher = async (url, options) => {
    if (options.method === "PUT") {
      const offset = Number(new URL(url).searchParams.get("offset"));
      offsets.push(offset);
      if (offset > 0 && !interrupted) {
        interrupted = true;
        throw new Error("Fictional interrupted network");
      }
    }
    return fetch(url, options);
  };
  const transport = new Transport(
    db,
    () => config,
    () => "",
    () => {},
    fetcher,
  );
  await transport.transfer(row);
  assert.equal(db.get(row.id).state, "retry");
  assert.equal(db.get(row.id).uploaded_bytes, 4 * 1024 * 1024);
  await transport.transfer(db.get(row.id));
  assert.equal(db.get(row.id).state, "received");
  assert.deepEqual(offsets, [0, 4 * 1024 * 1024, 4 * 1024 * 1024]);
  assert.equal(
    await fsp.readFile(row.staged_path).then((data) => data.equals(content)),
    true,
  );
  const statusCalls = [];
  transport.fetcher = async (url, options) => {
    statusCalls.push({ url, body: options.body });
    return fetch(url, options);
  };
  await transport.statuses();
  assert.equal(JSON.parse(db.get(row.id).remote).state, "awaiting_lesson");
  assert.equal(statusCalls.length, 1);
  assert.ok(statusCalls[0].url.endsWith("/v1/status"));
  assert.deepEqual(JSON.parse(statusCalls[0].body).sha256, [row.sha256]);
  assert.ok(statusCalls[0].body.length < 200);
});

test("a lost final acknowledgement is recovered without re-uploading content", async (t) => {
  const { root, db, row } = await fixture(t);
  const { endpoint } = await receiver(t, root);
  const config = {
    endpoint,
    workspaceId: "teacher",
    clientId: "fictional-client",
    pauseUploads: false,
  };
  let lost = false,
    puts = 0;
  const transport = new Transport(
    db,
    () => config,
    () => "",
    () => {},
    async (url, options) => {
      if (options.method === "PUT") puts++;
      const response = await fetch(url, options);
      if (url.endsWith("/complete") && !lost) {
        lost = true;
        await response.arrayBuffer();
        throw new Error("Fictional lost receipt");
      }
      return response;
    },
  );
  await transport.transfer(row);
  assert.equal(db.get(row.id).state, "retry");
  const firstPuts = puts;
  await transport.transfer(db.get(row.id));
  assert.equal(db.get(row.id).state, "received");
  assert.equal(puts, firstPuts);
});

test("wrong receipt enters attention and retains the staged file", async (t) => {
  const { db, row } = await fixture(t);
  const receipt = {
    sha256: row.sha256,
    byte_length: row.bytes,
    workspace_id: "wrong-space",
    upload_id: "up_" + row.sha256,
    asset_id: "asset_fake",
    received_at: new Date().toISOString(),
  };
  const transport = new Transport(
    db,
    () => ({
      endpoint: "http://fictional.invalid",
      workspaceId: "teacher",
      clientId: "fictional-client",
    }),
    () => "",
    () => {},
    async () =>
      new Response(
        JSON.stringify({
          upload_id: receipt.upload_id,
          workspace_id: "teacher",
          offset: row.bytes,
          receipt,
        }),
      ),
  );
  await transport.transfer(row);
  assert.equal(db.get(row.id).state, "attention");
  assert.equal(db.get(row.id).receipt, null);
  assert.equal((await fsp.stat(row.staged_path)).size, row.bytes);
});

test("auth failures are actionable instead of endless automatic retries", async (t) => {
  const { db, row } = await fixture(t);
  const transport = new Transport(
    db,
    () => ({ endpoint: "http://fictional.invalid", workspaceId: "teacher" }),
    () => "FICTIONAL TOKEN",
    () => {},
    async () => new Response("{}", { status: 401 }),
  );
  await transport.transfer(row);
  assert.equal(db.get(row.id).state, "attention");
  assert.match(db.get(row.id).error, /凭据无效/);
  assert.ok(!JSON.stringify(db.logs()).includes("FICTIONAL TOKEN"));
});

test("paused uploads still follow persisted processing state using only recording identities", async (t) => {
  const { db, row } = await fixture(t);
  const config = { endpoint: "http://fictional.invalid", workspaceId: "teacher", pauseUploads: true };
  const receipt = { asset_id: "asset_fictional", sha256: row.sha256, workspace_id: "teacher" };
  db.update(row.id, { state: "received", endpoint: config.endpoint, workspace_id: "teacher", receipt: JSON.stringify(receipt) });
  const calls = [];
  const transport = new Transport(db, () => config, () => "", () => {}, async (url, options) => {
    calls.push({url, options});
    return new Response(JSON.stringify({ workspace_id: "teacher", items: [
      { sha256: row.sha256, asset_id: receipt.asset_id, state: "analyzing" },
    ] }));
  });
  await transport.tick();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/v1/status"));
  assert.deepEqual(JSON.parse(calls[0].options.body), { workspace_id: "teacher", sha256: [row.sha256] });
  assert.equal(JSON.parse(db.get(row.id).remote).state, "analyzing");
  assert.ok(transport.nextStatusAt - Date.now() <= 5000);
});

test("result reads require the accepted recording and both current saved reports for completion", async (t) => {
  const { db, row } = await fixture(t);
  const config = { endpoint: "http://fictional.invalid", workspaceId: "teacher" };
  const receipt = { asset_id: "asset_fictional", sha256: row.sha256, workspace_id: "teacher" };
  db.update(row.id, { state: "received", endpoint: config.endpoint, workspace_id: "teacher", receipt: JSON.stringify(receipt) });
  let result = { workspace_id: "teacher", asset_id: receipt.asset_id, sha256: row.sha256, state: "analyzed", complete: true,
    reports: [{ id: "fictional-brief", kind: "brief", title: "虚构复盘", text: "虚构已保存复盘", stale: 0 }] };
  const transport = new Transport(db, () => config, () => "", () => {}, async (url, options) => {
    assert.ok(url.endsWith(`/v1/recordings/${row.sha256}/results`));
    assert.equal(options.body, undefined);
    return new Response(JSON.stringify(result));
  });
  await assert.rejects(() => transport.results(row.id), /尚未确认完成/);
  result.reports.push({ id: "fictional-preparation", kind: "preparation", title: "虚构备课", text: "虚构已保存备课", stale: 0 });
  assert.equal((await transport.results(row.id)).complete, true);
  result.asset_id = "asset_another";
  await assert.rejects(() => transport.results(row.id), /回执不匹配/);
  assert.equal(db.get(row.id).receipt, JSON.stringify(receipt));
});
