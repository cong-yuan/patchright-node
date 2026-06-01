const http = require("http");
const { chromium } = require("patchright");
const {
  attachConversationStreamListener,
} = require("./plugins/conversation-stream-listener");

const CHAT_URL =
  process.env.CHAT_URL ||
  "https://chatgpt.com/c/WEB:5131f56b-a35c-4e1c-bfe7-7f2b9d83a385";
const PORT = Number(process.env.PORT || 8787);
const DEFAULT_MODEL = process.env.MODEL_NAME || "chatgpt-web-proxy";
const SYSTEM_FINGERPRINT =
  process.env.SYSTEM_FINGERPRINT || "fp_patchright_node_proxy_v1";
const NEW_CHAT_URL = process.env.NEW_CHAT_URL || "https://chatgpt.com/";

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
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

function estimateTokens(text) {
  if (!text) return 0;
  // Lightweight approximation to provide OpenAI-compatible usage fields.
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function estimatePromptTokens(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  let count = 0;
  for (const msg of messages) {
    if (typeof msg?.content === "string") {
      count += estimateTokens(msg.content);
      continue;
    }

    if (Array.isArray(msg?.content)) {
      const merged = msg.content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
      count += estimateTokens(merged);
    }
  }

  return count;
}

function buildChatCompletionResponse({ body, result }) {
  const created = Math.floor(Date.now() / 1000);
  const answer = result.text;
  const model =
    body.model || result.resolvedModelSlug || result.modelSlug || DEFAULT_MODEL;
  const promptTokens = estimatePromptTokens(body.messages);
  const completionTokens = estimateTokens(answer);
  const totalTokens = promptTokens + completionTokens;

  return {
    id: result.assistantMessageId || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created,
    model,
    system_fingerprint: SYSTEM_FINGERPRINT,
    service_tier: "default",
    conversation_id: result.conversationId || null,
    request_id: result.requestId || null,
    turn_exchange_id: result.turnExchangeId || null,
    turn_trace_id: result.turnTraceId || null,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: answer,
          refusal: null,
        },
        logprobs: null,
        finish_reason: result.finishReason || "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      prompt_tokens_details: {
        cached_tokens: 0,
        audio_tokens: 0,
      },
      completion_tokens_details: {
        reasoning_tokens: 0,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    },
  };
}

function createPageConversationClient(page, listener, sessionId) {
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
    return listener.waitForNextFinalResponse({ timeoutMs: 180000 });
  }

  async function runConversation(userText) {
    console.log(`\n[session:${sessionId}] [Q] ${userText}`);
    await sendMessage(userText);
    const result = await receiveFinalResult();
    console.log(`[session:${sessionId}] [A] ${result.text}`);
    return result;
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

async function createSession(context, chatUrl) {
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const page = await context.newPage();
  const listener = await attachConversationStreamListener(page, {
    debug: false,
  });
  await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
  const conversationClient = createPageConversationClient(
    page,
    listener,
    sessionId,
  );
  await conversationClient.waitUntilReady();

  return {
    id: sessionId,
    created: Math.floor(Date.now() / 1000),
    chatUrl,
    page,
    conversationClient,
  };
}

function buildSessionResponse(session) {
  return {
    id: session.id,
    object: "session",
    created: session.created,
    status: "ready",
    chat_url: session.chatUrl,
  };
}

function createApiServer({ port, context, conversationClient }) {
  const sessions = new Map();
  sessions.set("default", {
    id: "default",
    created: Math.floor(Date.now() / 1000),
    chatUrl: CHAT_URL,
    conversationClient,
  });

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      return jsonResponse(res, 200, { ok: true, sessions: sessions.size });
    }

    if (req.method === "POST" && req.url === "/v1/sessions") {
      try {
        const body = await parseBody(req);
        const chatUrl =
          typeof body.chat_url === "string" ? body.chat_url : NEW_CHAT_URL;
        const session = await createSession(context, chatUrl);
        sessions.set(session.id, session);
        return jsonResponse(res, 200, buildSessionResponse(session));
      } catch (error) {
        return jsonResponse(res, 500, {
          error: error?.message || String(error),
        });
      }
    }

    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      return jsonResponse(res, 404, { error: "not found" });
    }

    try {
      const body = await parseBody(req);

      if (body.stream === true) {
        return jsonResponse(res, 400, {
          error:
            "stream=true is not supported; only final response is returned",
        });
      }

      const userText = extractUserMessage(body.messages);
      if (!userText) {
        return jsonResponse(res, 400, { error: "missing user message" });
      }

      const sessionId =
        typeof body.session_id === "string" && body.session_id
          ? body.session_id
          : "default";
      const session = sessions.get(sessionId);
      if (!session) {
        return jsonResponse(res, 404, {
          error: `session not found: ${sessionId}`,
        });
      }

      const result = await session.conversationClient.runConversation(userText);
      return jsonResponse(
        res,
        200,
        buildChatCompletionResponse({ body, result }),
      );
    } catch (error) {
      return jsonResponse(res, 500, {
        error: error?.message || String(error),
      });
    }
  });

  server.listen(port, () => {
    console.log(`OpenAI-compatible API listening on http://127.0.0.1:${port}`);
    console.log(`POST http://127.0.0.1:${port}/v1/sessions`);
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
  });

  await page.goto(CHAT_URL, { waitUntil: "domcontentloaded" });

  const conversationClient = createPageConversationClient(
    page,
    listener,
    "default",
  );
  await conversationClient.waitUntilReady();
  createApiServer({ port: PORT, context, conversationClient });
}

main().catch((error) => {
  console.error("[fatal]", error?.stack || error?.message || String(error));
  process.exit(1);
});
