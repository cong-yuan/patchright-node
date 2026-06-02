const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeSessionRecord(record) {
  if (!record || typeof record !== "object") {
    throw new TypeError("session record must be an object");
  }

  if (typeof record.accountUuid !== "string" || !record.accountUuid.trim()) {
    throw new TypeError("session record.accountUuid is required");
  }

  if (typeof record.tabSessionId !== "string" || !record.tabSessionId.trim()) {
    throw new TypeError("session record.tabSessionId is required");
  }

  const createdAt = record.createdAt || nowIso();
  const updatedAt = record.updatedAt || createdAt;

  return {
    accountUuid: record.accountUuid.trim(),
    tabSessionId: record.tabSessionId.trim(),
    webSessionId:
      typeof record.webSessionId === "string" && record.webSessionId.trim()
        ? record.webSessionId.trim()
        : null,
    chatUrl:
      typeof record.chatUrl === "string" && record.chatUrl.trim()
        ? record.chatUrl.trim()
        : null,
    status: typeof record.status === "string" && record.status.trim()
      ? record.status.trim()
      : "ready",
    isDefault: Boolean(record.isDefault),
    createdAt,
    updatedAt,
    lastUsedAt:
      typeof record.lastUsedAt === "string" && record.lastUsedAt.trim()
        ? record.lastUsedAt.trim()
        : updatedAt,
  };
}

class JsonSessionStore {
  constructor({ filePath }) {
    this.filePath = filePath || path.join(process.cwd(), "data", "sessions.json");
    this.sessions = [];
    this.byTabSessionId = new Map();
    this.byWebSessionId = new Map();
    this.writeQueue = Promise.resolve();
  }

  rebuildIndexes() {
    this.byTabSessionId.clear();
    this.byWebSessionId.clear();

    for (const session of this.sessions) {
      this.byTabSessionId.set(session.tabSessionId, session);
      if (session.webSessionId) {
        this.byWebSessionId.set(session.webSessionId, session);
      }
    }
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
      this.sessions = sessions.map((session) => normalizeSessionRecord(session));
      this.rebuildIndexes();
      return this.listSessions();
    } catch (error) {
      if (error && error.code === "ENOENT") {
        this.sessions = [];
        this.rebuildIndexes();
        return [];
      }
      throw error;
    }
  }

  listSessions() {
    return this.sessions.map((session) => clone(session));
  }

  getByTabSessionId(tabSessionId) {
    return clone(this.byTabSessionId.get(tabSessionId) || null);
  }

  getByWebSessionId(webSessionId) {
    return clone(this.byWebSessionId.get(webSessionId) || null);
  }

  getByAccountAndTabSessionId(accountUuid, tabSessionId) {
    const session = this.byTabSessionId.get(tabSessionId);
    if (!session || session.accountUuid !== accountUuid) return null;
    return clone(session);
  }

  getDefaultSession(accountUuid) {
    const session = this.sessions.find(
      (item) => item.accountUuid === accountUuid && item.isDefault,
    );
    return clone(session || null);
  }

  async upsertSession(record) {
    const next = normalizeSessionRecord(record);
    const now = nowIso();
    const existingByTab = this.byTabSessionId.get(next.tabSessionId) || null;
    const existingByWeb = next.webSessionId
      ? this.byWebSessionId.get(next.webSessionId) || null
      : null;
    const existing = existingByTab || existingByWeb;

    if (existing) {
      const previousTab = existing.tabSessionId;
      const previousWeb = existing.webSessionId;
      Object.assign(existing, next, {
        createdAt: existing.createdAt || next.createdAt || now,
        updatedAt: now,
        lastUsedAt: next.lastUsedAt || now,
      });
      if (previousTab !== existing.tabSessionId) {
        this.byTabSessionId.delete(previousTab);
      }
      if (previousWeb && previousWeb !== existing.webSessionId) {
        this.byWebSessionId.delete(previousWeb);
      }
      this.byTabSessionId.set(existing.tabSessionId, existing);
      if (existing.webSessionId) {
        this.byWebSessionId.set(existing.webSessionId, existing);
      }
    } else {
      const created = {
        ...next,
        createdAt: next.createdAt || now,
        updatedAt: now,
        lastUsedAt: next.lastUsedAt || now,
      };
      this.sessions.push(created);
      this.byTabSessionId.set(created.tabSessionId, created);
      if (created.webSessionId) {
        this.byWebSessionId.set(created.webSessionId, created);
      }
    }

    await this.save();
    return this.getByTabSessionId(next.tabSessionId);
  }

  async removeSession(tabSessionId) {
    const existing = this.byTabSessionId.get(tabSessionId);
    if (!existing) return null;

    this.sessions = this.sessions.filter((session) => session.tabSessionId !== tabSessionId);
    this.rebuildIndexes();
    await this.save();
    return clone(existing);
  }

  async save() {
    const payload = {
      version: 1,
      sessions: this.sessions.map((session) => clone(session)),
      savedAt: nowIso(),
    };

    const dir = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.mkdir(dir, { recursive: true });

    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await fs.rename(tempPath, this.filePath);
    });

    return this.writeQueue;
  }
}

module.exports = {
  JsonSessionStore,
  normalizeSessionRecord,
};
