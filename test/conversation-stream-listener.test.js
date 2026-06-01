const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  attachConversationStreamListener,
} = require("../plugins/conversation-stream-listener");

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
