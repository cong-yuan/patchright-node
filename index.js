const http = require("http");
const { chromium } = require("patchright");
const {
  attachConversationStreamListener,
} = require("./plugins/conversation-stream-listener");

const CHAT_URL =
  process.env.CHAT_URL ||
  "https://chatgpt.com/c/WEB:5131f56b-a35c-4e1c-bfe7-7f2b9d83a385";
const PORT = Number(process.env.PORT || 8787);

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function extractUserMessage(messages) {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;

    if (typeof msg.content === "string") return msg.content;

    if (Array.isArray(msg.content)) {
      const text = msg.content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
      if (text) return text;
    }
  }

  return "";
}

function createPageConversationClient(page, listener) {
  const input = page
    .locator('div[contenteditable="true"][id="prompt-textarea"]')
    .first();

  let queue = Promise.resolve();

  async function waitUntilReady() {
    await input.waitFor({ state: "visible", timeout: 30000 });
  }

  async function sendMessage(userText) {
    await input.click();
    await input.fill(userText);
    await input.press("Enter");
  }

  async function receiveFinalResult() {
    const result = await listener.waitForNextFinalResponse({ timeoutMs: 180000 });
    return result.text;
  }

  async function runConversation(userText) {
    await sendMessage(userText);
    return receiveFinalResult();
  }

  function enqueueConversation(userText) {
    const task = queue.then(() => runConversation(userText));
    queue = task.catch(() => undefined);
    return task;
  }

  return {
    waitUntilReady,
    runConversation: enqueueConversation,
  };
}

function createApiServer({ port, conversationClient }) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      return jsonResponse(res, 200, { ok: true });
    }

    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      return jsonResponse(res, 404, { error: "not found" });
    }

    try {
      const body = await parseBody(req);

      if (body.stream === true) {
        return jsonResponse(res, 400, {
          error: "stream=true is not supported; only final response is returned",
        });
      }

      const userText = extractUserMessage(body.messages);
      if (!userText) {
        return jsonResponse(res, 400, { error: "missing user message" });
      }

      const answer = await conversationClient.runConversation(userText);
      const created = Math.floor(Date.now() / 1000);

      return jsonResponse(res, 200, {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created,
        model: body.model || "chatgpt-web-proxy",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: answer,
            },
            finish_reason: "stop",
          },
        ],
      });
    } catch (error) {
      return jsonResponse(res, 500, {
        error: error?.message || String(error),
      });
    }
  });

  server.listen(port, () => {
    console.log(`OpenAI-compatible API listening on http://127.0.0.1:${port}`);
    console.log(`POST http://127.0.0.1:${port}/v1/chat/completions`);
  });

  return server;
}

async function main() {
  const context = await chromium.launchPersistentContext("./user-data", {
    channel: "chrome",
    headless: false,
    viewport: null,
  });

  const page = await context.newPage();
  const listener = await attachConversationStreamListener(page, {
    debug: false,
    printFinal: true,
  });

  await page.goto(CHAT_URL, { waitUntil: "domcontentloaded" });

  const conversationClient = createPageConversationClient(page, listener);
  await conversationClient.waitUntilReady();
  createApiServer({ port: PORT, conversationClient });
}

main().catch((error) => {
  console.error("[fatal]", error?.stack || error?.message || String(error));
  process.exit(1);
});
