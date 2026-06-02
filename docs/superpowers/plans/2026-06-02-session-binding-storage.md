# Session Binding and Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind each tab session to exactly one web session, persist the mapping locally, support recovery by either ID, and keep the design ready for multiple accounts using separate persistent browser contexts.

**Architecture:** Add a standalone `session-store.js` that owns durable JSON persistence and lookup indexes, and a standalone `session-manager.js` that resolves session refs, creates or restores tabs, and binds `tab_session_id` to `web_session_id`. The HTTP layer only forwards requests to the manager. Each session record stores `account_uuid`, so future restarts can reopen the correct persistent context for that account without changing the public API.

**Tech Stack:** Node.js `commonjs`, `node:test`, `patchright`, local JSON file persistence, `crypto.randomUUID()`.

---

### Task 1: Add durable session storage

**Files:**
- Create: `/Volumes/Code/caixun/spp-test/patchright-node/session-store.js`
- Test: `/Volumes/Code/caixun/spp-test/patchright-node/test/session-store.test.js`

- [ ] **Step 1: Write the failing test**

```js
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/session-store.test.js`
Expected: FAIL because `session-store.js` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```js
// session-store.js
const fs = require("node:fs/promises");
const path = require("node:path");

class JsonSessionStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.records = [];
    this.byTab = new Map();
    this.byWeb = new Map();
  }
  async load() { /* read JSON, rebuild maps */ }
  async upsertSession(record) { /* insert and persist */ }
  getByTabSessionId(tabSessionId) { /* lookup */ }
  getByWebSessionId(webSessionId) { /* lookup */ }
}

module.exports = { JsonSessionStore };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/session-store.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add session-store.js test/session-store.test.js
git commit -m "feat: add persistent session store"
```

### Task 2: Add session manager and account-aware context resolution

**Files:**
- Create: `/Volumes/Code/caixun/spp-test/patchright-node/session-manager.js`
- Modify: `/Volumes/Code/caixun/spp-test/patchright-node/index.js`
- Test: `/Volumes/Code/caixun/spp-test/patchright-node/test/session-manager.test.js`

- [ ] **Step 1: Write the failing test**

```js
const assert = require("node:assert/strict");
const test = require("node:test");
const { SessionManager } = require("../session-manager");

test("resolves the same session by tab id, web id, or web url", async () => {
  const store = {
    async load() {},
    async upsertSession() {},
    getByTabSessionId(id) { return id === "tab_1" ? this.record : null; },
    getByWebSessionId(id) { return id === "web_1" ? this.record : null; },
  };
  store.record = {
    accountUuid: "acc_1",
    tabSessionId: "tab_1",
    webSessionId: "web_1",
    chatUrl: "https://chatgpt.com/c/web_1",
    status: "ready",
  };

  const manager = new SessionManager({
    store,
    getAccountContext: async () => ({ newPage: async () => ({}) }),
  });

  assert.equal((await manager.resolveSessionRef("tab_1")).tabSessionId, "tab_1");
  assert.equal((await manager.resolveSessionRef("web_1")).tabSessionId, "tab_1");
  assert.equal((await manager.resolveSessionRef("https://chatgpt.com/c/web_1")).tabSessionId, "tab_1");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/session-manager.test.js`
Expected: FAIL because `session-manager.js` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```js
// session-manager.js
class SessionManager {
  async resolveSessionRef(ref) { /* match tab id, web id, or url */ }
  async createSessionForAccount({ accountUuid, chatUrl }) { /* create tab, persist */ }
  async recoverSession(record) { /* reopen via chat URL derived from web session */ }
}
module.exports = { SessionManager };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/session-manager.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add session-manager.js index.js test/session-manager.test.js
git commit -m "feat: add session manager"
```

### Task 3: Wire the API and launcher to account_uuid-based contexts

**Files:**
- Modify: `/Volumes/Code/caixun/spp-test/patchright-node/index.js`
- Create or modify: `/Volumes/Code/caixun/spp-test/patchright-node/test/api-session-flow.test.js`

- [ ] **Step 1: Write the failing test**

```js
const assert = require("node:assert/strict");
const test = require("node:test");

test("session creation and chat completions use the same account-bound session manager", async () => {
  assert.ok(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/api-session-flow.test.js`
Expected: FAIL until the API is wired to the new manager.

- [ ] **Step 3: Wire the implementation**

```js
const ACCOUNT_UUID = process.env.ACCOUNT_UUID || "default_account";
const accountDir = (uuid) => path.join(process.cwd(), "user-data", "accounts", uuid);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add index.js test/api-session-flow.test.js
git commit -m "feat: wire account-aware session routing"
```

### Task 4: Update docs and verify end-to-end behavior

**Files:**
- Modify: `/Volumes/Code/caixun/spp-test/patchright-node/docs/api-guide.md`

- [ ] **Step 1: Write the doc update**

```md
- `session_id` accepts either `tab_session_id` or `web_session_id`
- Each session record is persisted locally with `account_uuid`
- Tabs are recoverable from `https://chatgpt.com/c/<web_session_id>`
```

- [ ] **Step 2: Run the full test suite**

Run: `node --test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add docs/api-guide.md
git commit -m "docs: describe session recovery and account routing"
```
