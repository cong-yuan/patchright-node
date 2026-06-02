const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { JsonSessionStore } = require("../session-store");

test("persists and reloads tab/web session bindings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-"));
  const filePath = path.join(dir, "sessions.json");

  const store1 = new JsonSessionStore({ filePath });
  await store1.load();
  await store1.upsertSession({
    accountUuid: "acc_1",
    tabSessionId: "tab_1",
    webSessionId: "web_1",
    chatUrl: "https://chatgpt.com/c/web_1",
    status: "ready",
  });

  const store2 = new JsonSessionStore({ filePath });
  await store2.load();

  assert.equal(store2.getByTabSessionId("tab_1").webSessionId, "web_1");
  assert.equal(store2.getByWebSessionId("web_1").tabSessionId, "tab_1");
  assert.equal(store2.listSessions().length, 1);
});
