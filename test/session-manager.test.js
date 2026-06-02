const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SessionManager } = require("../session-manager");

test("resolves the same session by tab id, web id, or web url", async () => {
  const record = {
    accountUuid: "acc_1",
    tabSessionId: "tab_1",
    webSessionId: "web_1",
    chatUrl: "https://chatgpt.com/c/web_1",
    status: "ready",
  };

  const store = {
    async load() {},
    async upsertSession() {},
    getByTabSessionId(id) {
      return id === record.tabSessionId ? record : null;
    },
    getByWebSessionId(id) {
      return id === record.webSessionId ? record : null;
    },
    listSessions() {
      return [record];
    },
  };

  const manager = new SessionManager({
    store,
    launchAccountContext: async () => ({
      newPage: async () => ({}),
    }),
    createConversationClient: () => ({
      waitUntilReady: async () => {},
      runConversation: async () => ({ text: "ok" }),
      runConversationStream: async () => ({ text: "ok" }),
    }),
  });

  assert.equal((await manager.resolveSessionRef("tab_1")).tabSessionId, "tab_1");
  assert.equal((await manager.resolveSessionRef("web_1")).tabSessionId, "tab_1");
  assert.equal(
    (await manager.resolveSessionRef("https://chatgpt.com/c/web_1")).tabSessionId,
    "tab_1",
  );
});

test("creates account-specific sessions and recovers using the web session url", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-"));
  const launches = [];

  function createFakePage(initialUrl = "https://chatgpt.com/") {
    let currentUrl = initialUrl;
    return {
      async goto(url) {
        currentUrl = url;
      },
      url() {
        return currentUrl;
      },
      on() {},
      async exposeBinding() {},
      async addInitScript() {},
      locator() {
        return {
          first() {
            return this;
          },
          async waitFor() {},
          async click() {},
          async fill() {},
          async press() {},
        };
      },
      async close() {
        currentUrl = "closed";
      },
      _setUrl(url) {
        currentUrl = url;
      },
    };
  }

  function createFakeContext(accountUuid, userDataDir) {
    const page = createFakePage();
    return {
      accountUuid,
      userDataDir,
      page,
      async newPage() {
        return page;
      },
    };
  }

  const store = {
    sessions: [],
    async load() {},
    async upsertSession(record) {
      const index = this.sessions.findIndex(
        (item) => item.tabSessionId === record.tabSessionId,
      );
      if (index >= 0) {
        this.sessions[index] = { ...this.sessions[index], ...record };
      } else {
        this.sessions.push({ ...record });
      }
    },
    async removeSession(tabSessionId) {
      this.sessions = this.sessions.filter((item) => item.tabSessionId !== tabSessionId);
    },
    getByTabSessionId(id) {
      return this.sessions.find((item) => item.tabSessionId === id) || null;
    },
    getByWebSessionId(id) {
      return this.sessions.find((item) => item.webSessionId === id) || null;
    },
    listSessions() {
      return this.sessions.slice();
    },
    getDefaultSession(accountUuid) {
      return this.sessions.find(
        (item) => item.accountUuid === accountUuid && item.isDefault,
      ) || null;
    },
  };

  const contexts = new Map();
  const manager = new SessionManager({
    store,
    accountStorageRoot: tmpDir,
    launchAccountContext: async (accountUuid, { userDataDir }) => {
      launches.push({ accountUuid, userDataDir });
      const context = createFakeContext(accountUuid, userDataDir);
      contexts.set(accountUuid, context);
      return context;
    },
    createConversationClient: (page, _listener, tabSessionId) => ({
      async waitUntilReady() {},
      async runConversation(userText) {
        page._setUrl(`https://chatgpt.com/c/web_${tabSessionId.slice(-6)}`);
        return { text: `echo:${userText}` };
      },
      async runConversationStream(userText) {
        page._setUrl(`https://chatgpt.com/c/web_${tabSessionId.slice(-6)}`);
        return { text: `echo:${userText}` };
      },
    }),
  });

  await manager.init();
  const sessionA = await manager.createSession({
    accountUuid: "acc_a",
    chatUrl: "https://chatgpt.com/",
  });
  const sessionB = await manager.createSession({
    accountUuid: "acc_b",
    chatUrl: "https://chatgpt.com/",
  });

  assert.equal(sessionA.accountUuid, "acc_a");
  assert.equal(sessionB.accountUuid, "acc_b");
  assert.notEqual(sessionA.tabSessionId, sessionB.tabSessionId);
  assert.equal(launches.length, 2);
  assert.match(launches[0].userDataDir, /acc_a$/);
  assert.match(launches[1].userDataDir, /acc_b$/);

  const result = await manager.runConversation(sessionA.tabSessionId, "hello");
  assert.equal(result.result.text, "echo:hello");
  assert.match(result.session.webSessionId, /^web_/);
  assert.equal(
    store.getByTabSessionId(sessionA.tabSessionId).webSessionId,
    result.session.webSessionId,
  );

  const recovered = await manager.ensureSessionRuntime({
    ...store.getByTabSessionId(sessionA.tabSessionId),
  });
  assert.match(recovered.page.url(), new RegExp(`^https://chatgpt\\.com/c/${result.session.webSessionId}$`));
});

test("default sessions use the live runtime session returned by ensureSessionRuntime", async () => {
  const record = {
    accountUuid: "acc_default",
    tabSessionId: "tab_default",
    webSessionId: null,
    chatUrl: "https://chatgpt.com/",
    status: "ready",
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };

  const store = {
    async load() {},
    async upsertSession() {},
    getDefaultSession(accountUuid) {
      return accountUuid === record.accountUuid ? { ...record } : null;
    },
    getByTabSessionId() {
      return null;
    },
    getByWebSessionId() {
      return null;
    },
  };

  function createFakePage(initialUrl = "https://chatgpt.com/") {
    let currentUrl = initialUrl;
    return {
      async goto(url) {
        currentUrl = url;
      },
      url() {
        return currentUrl;
      },
      on() {},
      async exposeBinding() {},
      async addInitScript() {},
      locator() {
        return {
          first() {
            return this;
          },
          async waitFor() {},
          async click() {},
          async fill() {},
          async press() {},
        };
      },
      async close() {
        currentUrl = "closed";
      },
      _setUrl(url) {
        currentUrl = url;
      },
    };
  }

  const manager = new SessionManager({
    store,
    launchAccountContext: async () => ({
      newPage: async () => createFakePage(),
    }),
    createConversationClient: (page) => ({
      async waitUntilReady() {},
      async runConversation(userText) {
        page._setUrl("https://chatgpt.com/c/web_default");
        return { text: `reply:${userText}` };
      },
      async runConversationStream(userText) {
        page._setUrl("https://chatgpt.com/c/web_default");
        return { text: `reply:${userText}` };
      },
    }),
  });

  await manager.init();
  const runtime = await manager.ensureDefaultSession("acc_default");
  assert.equal(typeof runtime.conversationClient?.runConversation, "function");

  const result = await manager.runConversation("default", "hello");
  assert.equal(result.result.text, "reply:hello");

  const streamResult = await manager.runConversationStream("default", "world");
  assert.equal(streamResult.result.text, "reply:world");
});
