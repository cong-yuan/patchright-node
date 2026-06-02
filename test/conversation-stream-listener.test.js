const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  attachConversationStreamListener,
} = require("../plugins/conversation-stream-listener");
const {
  buildWebPromptFromOpenAiBody,
  logChatCompletionRequest,
} = require("../index");

class FakeTarget extends EventEmitter {
  async exposeBinding(_name, callback) {
    this.binding = callback;
  }

  async addInitScript() {}

  send(payload) {
    this.binding({}, payload);
  }
}

function sseData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

test("clearPending prevents stale delta waiters from consuming the next response", async () => {
  const target = new FakeTarget();
  const listener = attachConversationStreamListener(target);
  await Promise.resolve();

  const staleWaiter = listener.waitForNextDelta({ timeoutMs: 1000 });
  listener.clearPending();

  target.send({ type: "start", id: "stream-1", url: "/backend-api/f/conversation" });
  target.send({
    type: "chunk",
    id: "stream-1",
    url: "/backend-api/f/conversation",
    text: sseData({ v: "Hello! 👋 How can I help you " }),
  });
  target.send({
    type: "chunk",
    id: "stream-1",
    url: "/backend-api/f/conversation",
    text: sseData({ v: "today?" }),
  });

  assert.equal(await staleWaiter, null);
  assert.equal(
    await listener.waitForNextDelta({ timeoutMs: 0 }),
    "Hello! 👋 How can I help you ",
  );
  assert.equal(await listener.waitForNextDelta({ timeoutMs: 0 }), "today?");
});

test("cancelPendingDeltaWaiters keeps final-race waiters from consuming trailing deltas", async () => {
  const target = new FakeTarget();
  const listener = attachConversationStreamListener(target);
  await Promise.resolve();

  const staleWaiter = listener.waitForNextDelta({ timeoutMs: 1000 });
  listener.cancelPendingDeltaWaiters();

  target.send({ type: "start", id: "stream-1", url: "/backend-api/f/conversation" });
  target.send({
    type: "chunk",
    id: "stream-1",
    url: "/backend-api/f/conversation",
    text: sseData({ v: " 有什么想聊" }),
  });

  assert.equal(await staleWaiter, null);
  assert.equal(await listener.waitForNextDelta({ timeoutMs: 0 }), " 有什么想聊");
});

test("buildWebPromptFromOpenAiBody sends only the last message when tools are disabled", () => {
  const prompt = buildWebPromptFromOpenAiBody({
    messages: [
      { role: "system", content: "你是一个简洁助手" },
      { role: "user", content: "你是谁" },
      {
        role: "tool",
        content: [
          {
            type: "text",
            text: "这是工具执行结果",
          },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "search_docs",
          description: "search docs",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
          },
        },
      },
    ],
    tool_choice: "auto",
  }, {
    includeToolsInstruction: false,
  });

  assert.equal(prompt, "这是工具执行结果");
});

test("buildWebPromptFromOpenAiBody can include system and tools when onlyLastUserMessage is disabled", () => {
  const prompt = buildWebPromptFromOpenAiBody(
    {
      messages: [
        { role: "system", content: "你是一个简洁助手" },
        { role: "user", content: "你是谁" },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "最后一条助手消息",
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "search_docs",
            description: "search docs",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
          },
        },
      ],
      tool_choice: "auto",
    },
    {
      onlyLastUserMessage: false,
      includeToolsInstruction: true,
    },
  );

  assert.match(prompt, /System:/);
  assert.match(prompt, /Tooling Contract:/);
  assert.match(prompt, /search_docs/);
  assert.match(prompt, /User:/);
  assert.match(prompt, /最后一条助手消息/);
});

test("buildWebPromptFromOpenAiBody keeps tools when onlyLastUserMessage is enabled", () => {
  const prompt = buildWebPromptFromOpenAiBody(
    {
      messages: [
        { role: "system", content: "你是一个简洁助手" },
        { role: "user", content: "你是谁" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "search_docs",
            description: "search docs",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
          },
        },
      ],
      tool_choice: "auto",
    },
    {
      onlyLastUserMessage: true,
      includeToolsInstruction: true,
    },
  );

  assert.match(prompt, /你是谁/);
  assert.match(prompt, /search_docs/);
  assert.match(prompt, /tool_choice:/);
});

test("logChatCompletionRequest writes the full request body to jsonl", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "patchright-log-"));
  const logFilePath = path.join(tmpDir, "chat-completions.jsonl");
  const raw = JSON.stringify({
    model: "gpt-5",
    tools: [{ type: "function", function: { name: "search_docs" } }],
    messages: [{ role: "user", content: "hello" }],
  });
  const body = JSON.parse(raw);

  await logChatCompletionRequest({
    apiRequestId: "api_test_1",
    endpoint: "/v1/chat/completions",
    raw,
    body,
    parseOk: true,
    logFilePath,
  });

  const written = fs.readFileSync(logFilePath, "utf8").trim();
  assert.ok(written.length > 0);

  const parsed = JSON.parse(written);
  assert.equal(parsed.id, "api_test_1");
  assert.equal(parsed.endpoint, "/v1/chat/completions");
  assert.equal(parsed.parseOk, true);
  assert.equal(parsed.rawBody, raw);
  assert.deepEqual(parsed.body, body);
  assert.equal(parsed.includeToolsInWebPrompt, true);
});
