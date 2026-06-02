const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { once } = require("node:events");

const { chromium } = require("patchright");
const {
  createApiServer,
  createPageConversationClient,
  JsonSessionStore,
  SessionManager,
} = require("../index");

const RUN_REAL_API_TESTS = process.env.RUN_REAL_API_TESTS === "1";
const REAL_TEST_TIMEOUT_MS = Number(
  process.env.REAL_API_TEST_TIMEOUT_MS || 1_200_000,
);
const REAL_READY_TIMEOUT_MS = Number(
  process.env.REAL_API_READY_TIMEOUT_MS || 120_000,
);
const ACCOUNT_UUID = process.env.REAL_API_ACCOUNT_UUID || "test_account";
const SESSION_COUNT = Number(process.env.REAL_API_SESSION_COUNT || 12);
const TARGET_CLOSE_COUNT = Number(process.env.REAL_API_CLOSE_COUNT || 2);
const CHAT_URL = process.env.REAL_API_CHAT_URL || "https://chatgpt.com/";
const USER_DATA_SOURCE = path.join(process.cwd(), "user-data");

process.env.PAGE_READY_TIMEOUT_MS = String(REAL_READY_TIMEOUT_MS);

const runRealTest = RUN_REAL_API_TESTS ? test : test.skip;

async function copyProfileTree(sourceDir, targetDir) {
  await fs.cp(sourceDir, targetDir, { recursive: true });
  const lockFiles = [
    path.join(targetDir, "Default", "LOCK"),
    path.join(targetDir, "Default", "SingletonLock"),
    path.join(targetDir, "Default", "SingletonCookie"),
    path.join(targetDir, "Default", "SingletonSocket"),
  ];

  await Promise.all(
    lockFiles.map(async (filePath) => {
      try {
        await fs.rm(filePath, { force: true });
      } catch {}
    }),
  );
}

async function waitForJsonResponse(response) {
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`expected JSON response, got: ${text.slice(0, 400)}`);
  }
  return payload;
}

runRealTest(
  "real API flow creates many sessions and recovers closed tabs by web session id",
  { timeout: REAL_TEST_TIMEOUT_MS },
  async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "patchright-real-api-"));
    const profileRoot = path.join(tmpRoot, "profiles");
    const storeFile = path.join(tmpRoot, "sessions.json");
    const browserDirs = new Map();
    const contexts = new Map();

    await fs.mkdir(profileRoot, { recursive: true });

    const store = new JsonSessionStore({ filePath: storeFile });
    await store.load();

    const sessionManager = new SessionManager({
      store,
      defaultAccountUuid: ACCOUNT_UUID,
      defaultChatUrl: CHAT_URL,
      newChatUrl: CHAT_URL,
      accountStorageRoot: profileRoot,
      launchAccountContext: async (accountUuid, { userDataDir }) => {
        if (contexts.has(accountUuid)) {
          return contexts.get(accountUuid);
        }

        const dir =
          userDataDir || path.join(profileRoot, accountUuid);
        browserDirs.set(accountUuid, dir);
        await copyProfileTree(USER_DATA_SOURCE, dir);
        const context = await chromium.launchPersistentContext(dir, {
          channel: "chrome",
          headless: true,
          viewport: null,
        });
        contexts.set(accountUuid, context);
        return context;
      },
      createConversationClient: createPageConversationClient,
    });

    await sessionManager.init();
    const server = createApiServer({ port: 0, sessionManager });
    await once(server, "listening");
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const postJson = async (url, body) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await waitForJsonResponse(response);
      assert.equal(response.status, 200, JSON.stringify(payload));
      return payload;
    };

    const deleteJson = async (url) => {
      const response = await fetch(url, { method: "DELETE" });
      const payload = await waitForJsonResponse(response);
      assert.equal(response.status, 200, JSON.stringify(payload));
      return payload;
    };

    try {
      const created = [];
      for (let i = 0; i < SESSION_COUNT; i += 1) {
        const session = await postJson(`${baseUrl}/v1/sessions`, {
          account_uuid: ACCOUNT_UUID,
          chat_url: CHAT_URL,
        });
        created.push(session);
      }

      assert.equal(created.length, SESSION_COUNT);
      assert.equal(new Set(created.map((item) => item.id)).size, SESSION_COUNT);

      const targetSessions = created.slice(0, TARGET_CLOSE_COUNT);
      for (const session of targetSessions) {
        const response = await postJson(`${baseUrl}/v1/chat/completions`, {
          session_id: session.id,
          model: "gpt-5",
          messages: [
            {
              role: "user",
              content: "只回复 OK，不要解释。",
            },
          ],
        });

        assert.equal(response.object, "chat.completion");
        assert.ok(
          typeof response.choices?.[0]?.message?.content === "string" &&
            response.choices[0].message.content.trim().length > 0,
          "assistant response should be non-empty",
        );
      }

      const storedAfterBind = JSON.parse(await fs.readFile(storeFile, "utf8"));
      const boundRecords = storedAfterBind.sessions.filter((item) =>
        targetSessions.some((session) => session.id === item.tabSessionId),
      );
      assert.equal(boundRecords.length, TARGET_CLOSE_COUNT);
      for (const record of boundRecords) {
        assert.equal(typeof record.webSessionId, "string");
        assert.ok(record.webSessionId.length > 0);
        assert.match(record.chatUrl, /^https:\/\/chatgpt\.com\/c\//);
        assert.equal(record.status, "ready");
      }

      for (const session of targetSessions) {
        const closeResponse = await deleteJson(
          `${baseUrl}/v1/sessions/${encodeURIComponent(session.id)}`,
        );
        assert.equal(closeResponse.deleted, true);
        assert.equal(closeResponse.closed, true);
      }

      const storedAfterClose = JSON.parse(await fs.readFile(storeFile, "utf8"));
      const closedRecords = storedAfterClose.sessions.filter((item) =>
        targetSessions.some((session) => session.id === item.tabSessionId),
      );
      assert.equal(closedRecords.length, TARGET_CLOSE_COUNT);
      for (const record of closedRecords) {
        assert.equal(record.status, "closed");
        assert.equal(typeof record.webSessionId, "string");
        assert.ok(record.webSessionId.length > 0);
      }

      for (const record of closedRecords) {
        const reopened = await postJson(`${baseUrl}/v1/chat/completions`, {
          session_id: record.webSessionId,
          model: "gpt-5",
          messages: [
            {
              role: "user",
              content: "再回复一次 OK。",
            },
          ],
        });

        assert.equal(reopened.object, "chat.completion");
        assert.ok(
          typeof reopened.choices?.[0]?.message?.content === "string" &&
            reopened.choices[0].message.content.trim().length > 0,
          "reopened assistant response should be non-empty",
        );
      }

      const storedAfterRecovery = JSON.parse(await fs.readFile(storeFile, "utf8"));
      const recoveredRecords = storedAfterRecovery.sessions.filter((item) =>
        targetSessions.some((session) => session.id === item.tabSessionId),
      );
      for (const record of recoveredRecords) {
        assert.equal(record.status, "ready");
        assert.equal(typeof record.webSessionId, "string");
        assert.ok(record.webSessionId.length > 0);
      }
    } finally {
      server.close();
      await Promise.all(
        [...contexts.values()].map(async (context) => {
          try {
            await context.close();
          } catch {}
        }),
      );
    }
  },
);
