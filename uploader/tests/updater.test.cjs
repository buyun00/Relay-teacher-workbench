const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Updates } = require("../electron/core/updater.cjs");

function fixture() {
  const updater = new EventEmitter();
  updater.setFeedURL = (feed) => {
    updater.feed = feed;
  };
  updater.checkForUpdates = async () => {
    updater.emit("checking-for-update");
  };
  const client = {
    update: {},
    importer: { active: null, scanning: false },
    transport: { busy: false, stop() {} },
    config: () => ({
      releaseRepo: "fictional-owner/fictional-public-installer",
    }),
    changed() {},
    db: {
      setSetting(key, value) {
        client[key] = value;
      },
    },
    pause(value) {
      client.pauseUploads = value;
    },
  };
  let installed = 0;
  const updates = new Updates(updater, client, {
    packaged: true,
    install: async () => installed++,
  });
  return { updater, client, updates, installed: () => installed };
}

test("GitHub updates download automatically but never install on quit or merely on download", async () => {
  const { updater, client, updates, installed } = fixture();
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.feed.provider, "github");
  updater.emit("update-downloaded", { version: "0.1.1" });
  assert.equal(client.update.state, "downloaded");
  assert.equal(installed(), 0);
  await updates.apply();
  assert.equal(installed(), 1);
  assert.equal(client.pauseUploads, false);
});

test("update install defers until local copying/scanning is finished", async () => {
  const { updater, client, updates, installed } = fixture();
  updater.emit("update-downloaded", { version: "0.1.1" });
  client.importer.active = { filename: "fictional.wav" };
  await assert.rejects(updates.apply(), /等待本地复制结束/);
  assert.equal(installed(), 0);
  client.importer.active = null;
  client.importer.scanning = true;
  await assert.rejects(updates.apply(), /等待本地复制结束/);
  assert.equal(installed(), 0);
});

test("upgrading preserves an explicit upload pause preference", async () => {
  const { updater, client, updates } = fixture();
  client.config = () => ({
    releaseRepo: "fictional-owner/fictional-public-installer",
    pauseUploads: true,
  });
  updater.emit("update-downloaded", { version: "0.1.1" });
  await updates.apply();
  assert.equal(client.pauseUploads, true);
});
