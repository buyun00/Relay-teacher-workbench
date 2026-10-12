const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { ClassroomClient } = require("../electron/core/client.cjs");

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
