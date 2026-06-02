const path = require("node:path");
const crypto = require("node:crypto");
const {
  attachConversationStreamListener,
} = require("./plugins/conversation-stream-listener");

const DEFAULT_ACCOUNT_UUID = process.env.ACCOUNT_UUID || "default_account";
const DEFAULT_CHAT_URL =
  process.env.CHAT_URL ||
  "https://chatgpt.com/c/WEB:5131f56b-a35c-4e1c-bfe7-7f2b9d83a385";
const DEFAULT_NEW_CHAT_URL = process.env.NEW_CHAT_URL || "https://chatgpt.com/";

function makeTabSessionId() {
  return `tab_${crypto.randomUUID()}`;
}

function extractWebSessionIdFromUrl(value) {
  if (typeof value !== "string" || !value) return null;

  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/^\/c\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    const match = value.match(/\/c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

function buildWebSessionUrl(webSessionId) {
  return `https://chatgpt.com/c/${encodeURIComponent(webSessionId)}`;
}

class SessionManager {
  constructor({
    store,
    launchAccountContext,
    createConversationClient,
    defaultAccountUuid = DEFAULT_ACCOUNT_UUID,
    defaultChatUrl = DEFAULT_CHAT_URL,
    newChatUrl = DEFAULT_NEW_CHAT_URL,
    accountStorageRoot = path.join(process.cwd(), "user-data", "accounts"),
  }) {
    if (!store) throw new TypeError("store is required");
    if (typeof launchAccountContext !== "function") {
      throw new TypeError("launchAccountContext is required");
    }
    if (typeof createConversationClient !== "function") {
      throw new TypeError("createConversationClient is required");
    }

    this.store = store;
    this.launchAccountContext = launchAccountContext;
    this.createConversationClient = createConversationClient;
    this.defaultAccountUuid = defaultAccountUuid;
    this.defaultChatUrl = defaultChatUrl;
    this.newChatUrl = newChatUrl;
    this.accountStorageRoot = accountStorageRoot;
    this.accountContexts = new Map();
    this.defaultSessionByAccount = new Map();
    this.runtimeSessionsByTab = new Map();
    this.runtimeSessionsByWeb = new Map();
  }

  async init() {
    if (typeof this.store.load === "function") {
      await this.store.load();
    }
  }

  registerRuntimeSession(session) {
    if (!session || typeof session !== "object") return session;

    if (typeof session.tabSessionId === "string" && session.tabSessionId) {
      this.runtimeSessionsByTab.set(session.tabSessionId, session);
    }

    if (typeof session.webSessionId === "string" && session.webSessionId) {
      this.runtimeSessionsByWeb.set(session.webSessionId, session);
    }

    return session;
  }

  unregisterRuntimeSession(sessionOrTabId) {
    const session =
      typeof sessionOrTabId === "string"
        ? this.runtimeSessionsByTab.get(sessionOrTabId) ||
          this.runtimeSessionsByWeb.get(sessionOrTabId) ||
          null
        : sessionOrTabId;

    if (!session) return;

    if (typeof session.tabSessionId === "string" && session.tabSessionId) {
      this.runtimeSessionsByTab.delete(session.tabSessionId);
    }

    if (typeof session.webSessionId === "string" && session.webSessionId) {
      this.runtimeSessionsByWeb.delete(session.webSessionId);
    }
  }

  getAccountStorageDir(accountUuid) {
    return path.join(this.accountStorageRoot, accountUuid);
  }

  async getAccountContext(accountUuid = this.defaultAccountUuid) {
    if (!this.accountContexts.has(accountUuid)) {
      const ctx = await this.getAccountContextProvider(accountUuid);
      this.accountContexts.set(accountUuid, ctx);
    }
    return this.accountContexts.get(accountUuid);
  }

  async getAccountContextProvider(accountUuid) {
    return this.launchAccountContext(accountUuid, {
      accountUuid,
      userDataDir: this.getAccountStorageDir(accountUuid),
    });
  }

  resolveStoredSession(sessionRef) {
    if (typeof sessionRef !== "string" || !sessionRef.trim()) return null;
    const trimmed = sessionRef.trim();

    const byTab = this.store.getByTabSessionId(trimmed);
    if (byTab) return byTab;

    const byWeb = this.store.getByWebSessionId(trimmed);
    if (byWeb) return byWeb;

    const webSessionId = extractWebSessionIdFromUrl(trimmed);
    if (!webSessionId) return null;

    return this.store.getByWebSessionId(webSessionId);
  }

  resolveRuntimeSession(sessionRef) {
    if (typeof sessionRef !== "string" || !sessionRef.trim()) return null;
    const trimmed = sessionRef.trim();
    const byTab = this.runtimeSessionsByTab.get(trimmed);
    if (byTab) return byTab;

    const byWeb = this.runtimeSessionsByWeb.get(trimmed);
    if (byWeb) return byWeb;

    const webSessionId = extractWebSessionIdFromUrl(trimmed);
    if (!webSessionId) return null;
    return this.runtimeSessionsByWeb.get(webSessionId) || null;
  }

  async resolveSessionRef(sessionRef) {
    if (sessionRef === "default") {
      return this.ensureDefaultSession();
    }

    const runtime = this.resolveRuntimeSession(sessionRef);
    if (runtime) return runtime;

    const resolved = this.resolveStoredSession(sessionRef);
    if (resolved) return resolved;

    return null;
  }

  async ensureDefaultSession(accountUuid = this.defaultAccountUuid) {
    const existing = this.store.getDefaultSession(accountUuid);
    if (existing) {
      const runtime = await this.ensureSessionRuntime(existing);
      this.defaultSessionByAccount.set(accountUuid, runtime.tabSessionId);
      return runtime;
    }

    const created = await this.createSession({
      accountUuid,
      chatUrl: this.defaultChatUrl,
      isDefault: true,
    });
    this.defaultSessionByAccount.set(accountUuid, created.tabSessionId);
    return created;
  }

  async createSession({
    accountUuid = this.defaultAccountUuid,
    chatUrl = this.newChatUrl,
    isDefault = false,
  } = {}) {
    const context = await this.getAccountContext(accountUuid);
    const tabSessionId = makeTabSessionId();
    const page = await context.newPage();
    const listener = await attachConversationStreamListener(page, {
      debug: false,
    });
    await page.goto(chatUrl, { waitUntil: "domcontentloaded" });

    const conversationClient = this.createConversationClient(
      page,
      listener,
      tabSessionId,
    );
    await conversationClient.waitUntilReady();

    const webSessionId = extractWebSessionIdFromUrl(page.url?.() || "");
    const now = new Date().toISOString();
    const session = {
      accountUuid,
      tabSessionId,
      webSessionId,
      chatUrl: webSessionId ? buildWebSessionUrl(webSessionId) : chatUrl,
      status: "ready",
      isDefault,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      page,
      conversationClient,
    };

    await this.store.upsertSession({
      accountUuid: session.accountUuid,
      tabSessionId: session.tabSessionId,
      webSessionId: session.webSessionId,
      chatUrl: session.chatUrl,
      status: session.status,
      isDefault: session.isDefault,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastUsedAt: session.lastUsedAt,
    });

    return this.registerRuntimeSession(session);
  }

  async ensureSessionRuntime(session) {
    if (session.page && session.conversationClient) {
      return this.registerRuntimeSession(session);
    }

    const runtime = this.runtimeSessionsByTab.get(session.tabSessionId);
    if (runtime && runtime.page && runtime.conversationClient) {
      return runtime;
    }

    const accountUuid = session.accountUuid || this.defaultAccountUuid;
    const context = await this.getAccountContext(accountUuid);
    const page = await context.newPage();
    const listener = await attachConversationStreamListener(page, {
      debug: false,
    });
    const chatUrl = session.webSessionId
      ? buildWebSessionUrl(session.webSessionId)
      : session.chatUrl || this.newChatUrl;

    await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
    const conversationClient = this.createConversationClient(
      page,
      listener,
      session.tabSessionId,
    );
    await conversationClient.waitUntilReady();

    session.page = page;
    session.conversationClient = conversationClient;
    session.chatUrl = chatUrl;
    session.lastUsedAt = new Date().toISOString();
    session.status = "ready";

    return this.registerRuntimeSession(session);
  }

  async syncSessionBinding(session) {
    const currentWebSessionId = extractWebSessionIdFromUrl(session.page?.url?.() || "");
    const changed = currentWebSessionId && currentWebSessionId !== session.webSessionId;

    if (changed) {
      session.webSessionId = currentWebSessionId;
      session.chatUrl = buildWebSessionUrl(currentWebSessionId);
      const now = new Date().toISOString();
      session.updatedAt = now;
      session.lastUsedAt = now;
      await this.store.upsertSession({
        accountUuid: session.accountUuid,
        tabSessionId: session.tabSessionId,
        webSessionId: session.webSessionId,
        chatUrl: session.chatUrl,
        status: session.status,
        isDefault: session.isDefault,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lastUsedAt: session.lastUsedAt,
      });
    }
  }

  async getResolvedSession(sessionRef) {
    const session = await this.resolveSessionRef(sessionRef);
    if (!session) return null;
    return session;
  }

  async runConversation(sessionRef, userText) {
    let session = await this.getResolvedSession(sessionRef);
    if (!session) {
      throw new Error(`session not found: ${sessionRef}`);
    }
    session = await this.ensureSessionRuntime(session);
    session.lastUsedAt = new Date().toISOString();
    const result = await session.conversationClient.runConversation(userText);
    await this.syncSessionBinding(session);
    await this.store.upsertSession({
      accountUuid: session.accountUuid,
      tabSessionId: session.tabSessionId,
      webSessionId: session.webSessionId,
      chatUrl: session.chatUrl,
      status: session.status,
      isDefault: session.isDefault,
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
      lastUsedAt: session.lastUsedAt,
    });
    return { session, result };
  }

  async runConversationStream(sessionRef, userText, onDelta) {
    let session = await this.getResolvedSession(sessionRef);
    if (!session) {
      throw new Error(`session not found: ${sessionRef}`);
    }
    session = await this.ensureSessionRuntime(session);
    session.lastUsedAt = new Date().toISOString();
    const result = await session.conversationClient.runConversationStream(
      userText,
      onDelta,
    );
    await this.syncSessionBinding(session);
    await this.store.upsertSession({
      accountUuid: session.accountUuid,
      tabSessionId: session.tabSessionId,
      webSessionId: session.webSessionId,
      chatUrl: session.chatUrl,
      status: session.status,
      isDefault: session.isDefault,
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
      lastUsedAt: session.lastUsedAt,
    });
    return { session, result };
  }

  async deleteSession(sessionRef) {
    const session = await this.getResolvedSession(sessionRef);
    if (!session) {
      return null;
    }

    const isDefault = session.isDefault;
    if (session.page && typeof session.page.close === "function") {
      try {
        await session.page.close();
      } catch {}
    }

    this.unregisterRuntimeSession(session);
    session.page = null;
    session.conversationClient = null;
    session.status = "closed";
    const now = new Date().toISOString();
    session.updatedAt = now;
    session.lastUsedAt = now;
    await this.store.upsertSession({
      accountUuid: session.accountUuid,
      tabSessionId: session.tabSessionId,
      webSessionId: session.webSessionId,
      chatUrl: session.chatUrl,
      status: session.status,
      isDefault: session.isDefault,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastUsedAt: session.lastUsedAt,
    });

    if (isDefault) {
      const resetSession = await this.ensureDefaultSession(session.accountUuid);
      return { deletedSession: session, resetSession };
    }

    return { deletedSession: session, resetSession: null };
  }
}

module.exports = {
  SessionManager,
  extractWebSessionIdFromUrl,
  buildWebSessionUrl,
  makeTabSessionId,
};
