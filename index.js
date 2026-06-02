const http = require("http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("patchright");
const {
  attachConversationStreamListener,
} = require("./plugins/conversation-stream-listener");

const CHAT_URL =
  process.env.CHAT_URL ||
  "https://chatgpt.com/c/WEB:5131f56b-a35c-4e1c-bfe7-7f2b9d83a385";
const PORT = Number(process.env.PORT || 8989);
const DEFAULT_MODEL = process.env.MODEL_NAME || "chatgpt-web-proxy";
const SYSTEM_FINGERPRINT =
  process.env.SYSTEM_FINGERPRINT || "fp_patchright_node_proxy_v1";
const NEW_CHAT_URL = process.env.NEW_CHAT_URL || "https://chatgpt.com/";
const API_LOG = (process.env.API_LOG || "1") !== "0";
const API_LOG_USER_TEXT = (process.env.API_LOG_USER_TEXT || "1") !== "0";
const API_LOG_BODY_SNIPPET = (process.env.API_LOG_BODY_SNIPPET || "0") !== "0";
const API_LOG_BODY_MAX_CHARS = Number(
  process.env.API_LOG_BODY_MAX_CHARS || 4096,
);
const STREAM_REALTIME_DELTAS =
  (process.env.STREAM_REALTIME_DELTAS || "0") === "1";
const MAX_WEB_PROMPT_CHARS = Number(process.env.MAX_WEB_PROMPT_CHARS || 16000);
const MAX_TOOL_RESULTS_CHARS = Number(
  process.env.MAX_TOOL_RESULTS_CHARS || 4000,
);
const INCLUDE_TOOLS_IN_WEB_PROMPT =
  (process.env.INCLUDE_TOOLS_IN_WEB_PROMPT || "1") === "1";
const ONLY_LAST_MESSAGE_IN_WEB_PROMPT = (() => {
  const value =
    process.env.ONLY_LAST_MESSAGE_IN_WEB_PROMPT ??
    process.env.ONLY_LAST_USER_MESSAGE_IN_WEB_PROMPT ??
    "1";
  return value === "1";
})();
const CHAT_COMPLETION_REQUEST_LOG_FILE =
  process.env.CHAT_COMPLETION_REQUEST_LOG_FILE ||
  path.join(process.cwd(), "logs", "chat-completions.jsonl");

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeSnippet(value, maxLen = 200) {
  if (typeof value !== "string") return "";
  const s = value.replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

function logApi(payload) {
  if (!API_LOG) return;
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...payload }));
  } catch {}
}

async function appendJsonl(filePath, payload) {
  const line = `${JSON.stringify(payload)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, line, "utf8");
}

async function logChatCompletionRequest({
  apiRequestId,
  endpoint,
  raw,
  body,
  parseOk,
  logFilePath = CHAT_COMPLETION_REQUEST_LOG_FILE,
}) {
  const record = {
    ts: new Date().toISOString(),
    id: apiRequestId,
    endpoint,
    parseOk,
    rawLength: typeof raw === "string" ? raw.length : 0,
    rawBody: typeof raw === "string" ? raw : "",
    body: body || null,
    includeToolsInWebPrompt: INCLUDE_TOOLS_IN_WEB_PROMPT,
  };

  try {
    await appendJsonl(logFilePath, record);
  } catch (error) {
    logApi({
      type: "api.local_log_error",
      id: apiRequestId,
      endpoint,
      message: error?.message || String(error),
    });
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function parseJsonBody(raw) {
  if (!raw) return {};
  return JSON.parse(raw);
}

function extractMessageText(message) {
  if (!message || typeof message !== "object") return "";

  if (typeof message.content === "string") return message.content;

  if (Array.isArray(message.content)) {
    const text = message.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
    if (text) return text;
  }

  return "";
}

function extractLastMessageText(messages) {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const text = extractMessageText(msg);
    if (text) return text;
  }

  return "";
}

function extractSystemMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(
      (m) =>
        m?.role === "system" &&
        typeof m?.content === "string" &&
        m.content.trim(),
    )
    .map((m) => m.content.trim());
}

function extractToolResultMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m?.role === "tool")
    .map((m) => {
      const callId = typeof m?.tool_call_id === "string" ? m.tool_call_id : "";
      const content = typeof m?.content === "string" ? m.content.trim() : "";
      if (!content) return null;
      return { callId, content };
    })
    .filter(Boolean);
}

function buildToolsInstruction(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0) return "";

  const toolSpec = tools
    .map((tool) => ({
      type: tool?.type || "function",
      function: {
        name: tool?.function?.name || "",
        description: tool?.function?.description || "",
        parameters: tool?.function?.parameters || {},
      },
    }))
    .filter((t) => t.function.name);

  const choice =
    typeof toolChoice === "string"
      ? toolChoice
      : toolChoice && typeof toolChoice === "object"
        ? {
            type: toolChoice.type || null,
            function: {
              name:
                typeof toolChoice.function?.name === "string"
                  ? toolChoice.function.name
                  : null,
            },
          }
        : "auto";

  return [
    "You are operating in OpenAI tool-calling compatibility mode.",
    "If a tool should be called, output ONLY valid JSON with this exact shape:",
    '{"tool_calls":[{"name":"<tool_name>","arguments":{}}]}',
    "If no tool is needed, answer normally in plain text.",
    `tool_choice: ${JSON.stringify(choice)}`,
    `tools: ${JSON.stringify(toolSpec)}`,
  ].join("\n");
}

function buildCompactToolsInstruction(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0) return "";

  const compact = tools
    .map((tool) => {
      const fn = tool?.function || {};
      const props = fn?.parameters?.properties;
      const propertyTypes =
        props && typeof props === "object"
          ? Object.fromEntries(
              Object.entries(props).map(([k, v]) => [
                k,
                typeof v?.type === "string" ? v.type : "unknown",
              ]),
            )
          : {};
      return {
        name: typeof fn.name === "string" ? fn.name : "",
        description:
          typeof fn.description === "string"
            ? safeSnippet(fn.description, 120)
            : "",
        required: Array.isArray(fn?.parameters?.required)
          ? fn.parameters.required
          : [],
        properties: propertyTypes,
      };
    })
    .filter((x) => x.name);

  const choice =
    typeof toolChoice === "string"
      ? toolChoice
      : toolChoice && typeof toolChoice === "object"
        ? `${toolChoice.type || "function"}:${toolChoice.function?.name || ""}`
        : "auto";

  return [
    "Tool-calling mode. If calling tools, output ONLY JSON:",
    '{"tool_calls":[{"name":"<tool_name>","arguments":{}}]}',
    `tool_choice: ${choice}`,
    `tools: ${JSON.stringify(compact)}`,
  ].join("\n");
}

function truncateToolResults(toolResults, maxChars) {
  if (!Array.isArray(toolResults) || toolResults.length === 0) return [];
  let remain = Math.max(0, maxChars);
  const out = [];
  for (const item of toolResults) {
    if (remain <= 0) break;
    const text = item.content || "";
    const clipped = text.length > remain ? text.slice(0, remain) : text;
    if (clipped) out.push({ ...item, content: clipped });
    remain -= clipped.length;
  }
  return out;
}

function buildPromptSections({ systemMessages, toolsInstruction, toolResults, lastMessageText }) {
  const sections = [];
  if (systemMessages.length > 0) {
    sections.push(`System:\n${systemMessages.join("\n\n")}`);
  }
  if (toolsInstruction) {
    sections.push(`Tooling Contract:\n${toolsInstruction}`);
  }
  if (toolResults.length > 0) {
    sections.push(
      `Tool Results:\n${toolResults
        .map((r) => `tool_call_id=${r.callId || "unknown"}\n${r.content}`)
        .join("\n\n")}`,
    );
  }
  sections.push(`User:\n${lastMessageText}`);
  return sections.join("\n\n");
}

function buildWebPromptFromOpenAiBody(body, options = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const lastMessageText = extractLastMessageText(messages);
  if (!lastMessageText) return "";

  const onlyLastUserMessage =
    options.onlyLastUserMessage ?? ONLY_LAST_MESSAGE_IN_WEB_PROMPT;
  const systemMessages = extractSystemMessages(messages);
  const toolResults = extractToolResultMessages(messages);
  const includeToolsInstruction =
    options.includeToolsInstruction ?? INCLUDE_TOOLS_IN_WEB_PROMPT;
  const toolsInstruction = includeToolsInstruction
    ? buildToolsInstruction(body?.tools, body?.tool_choice)
    : "";

  if (onlyLastUserMessage) {
    const prompt = toolsInstruction
      ? `${lastMessageText}\n\nTooling Contract:\n${toolsInstruction}`
      : lastMessageText;
    return prompt.slice(0, MAX_WEB_PROMPT_CHARS);
  }

  let prompt = buildPromptSections({
    systemMessages,
    toolsInstruction,
    toolResults,
    lastMessageText,
  });
  if (prompt.length <= MAX_WEB_PROMPT_CHARS) return prompt;

  prompt = buildPromptSections({
    systemMessages,
    toolsInstruction,
    toolResults: truncateToolResults(toolResults, MAX_TOOL_RESULTS_CHARS),
    lastMessageText,
  });
  if (prompt.length <= MAX_WEB_PROMPT_CHARS) return prompt;

  prompt = buildPromptSections({
    systemMessages,
    toolsInstruction: buildCompactToolsInstruction(
      body?.tools,
      body?.tool_choice,
    ),
    toolResults: truncateToolResults(
      toolResults,
      Math.floor(MAX_TOOL_RESULTS_CHARS / 2),
    ),
    lastMessageText,
  });
  if (prompt.length <= MAX_WEB_PROMPT_CHARS) return prompt;

  return prompt.slice(0, MAX_WEB_PROMPT_CHARS);
}

function parseToolCallsFromAssistantText(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const candidates = [trimmed];
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) candidates.push(fencedMatch[1].trim());

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    const calls = Array.isArray(parsed?.tool_calls)
      ? parsed.tool_calls
      : Array.isArray(parsed)
        ? parsed
        : null;
    if (!calls || calls.length === 0) continue;

    const normalized = calls
      .map((c, idx) => {
        const name = c?.name || c?.function?.name;
        const argsObj =
          c?.arguments && typeof c.arguments === "object"
            ? c.arguments
            : c?.function?.arguments && typeof c.function.arguments === "object"
              ? c.function.arguments
              : null;
        const argsStr =
          typeof c?.arguments === "string"
            ? c.arguments
            : typeof c?.function?.arguments === "string"
              ? c.function.arguments
              : argsObj
                ? JSON.stringify(argsObj)
                : "{}";
        if (typeof name !== "string" || !name.trim()) return null;
        return {
          id: c?.id || `call_${Date.now()}_${idx}`,
          type: "function",
          function: {
            name: name.trim(),
            arguments: argsStr,
          },
        };
      })
      .filter(Boolean);

    if (normalized.length > 0) return normalized;
  }

  return null;
}

function buildAssistantMessageFromResult(result) {
  const toolCalls = parseToolCallsFromAssistantText(result?.text || "");
  if (toolCalls) {
    return {
      content: null,
      toolCalls,
      finishReason: "tool_calls",
      completionTextForUsage: JSON.stringify({ tool_calls: toolCalls }),
    };
  }

  return {
    content: result?.text || "",
    toolCalls: null,
    finishReason: result?.finishReason || "stop",
    completionTextForUsage: result?.text || "",
  };
}

function summarizeToolsForLog(tools) {
  if (!Array.isArray(tools)) return [];

  return tools.map((tool, index) => {
    const fn =
      tool?.function && typeof tool.function === "object" ? tool.function : {};
    const parameters =
      fn.parameters && typeof fn.parameters === "object" ? fn.parameters : null;

    return {
      index,
      type: typeof tool?.type === "string" ? tool.type : null,
      functionName: typeof fn.name === "string" ? fn.name : null,
      functionDescription:
        typeof fn.description === "string"
          ? safeSnippet(fn.description, 200)
          : null,
      parameterKeys: parameters ? Object.keys(parameters) : [],
    };
  });
}

function summarizeToolChoiceForLog(toolChoice) {
  if (toolChoice === undefined) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (!toolChoice || typeof toolChoice !== "object") return toolChoice;

  return {
    type: typeof toolChoice.type === "string" ? toolChoice.type : null,
    functionName:
      typeof toolChoice.function?.name === "string"
        ? toolChoice.function.name
        : null,
  };
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
  const assistant = buildAssistantMessageFromResult(result);
  const model =
    body.model || result.resolvedModelSlug || result.modelSlug || DEFAULT_MODEL;
  const promptTokens = estimatePromptTokens(body.messages);
  const completionTokens = estimateTokens(assistant.completionTextForUsage);
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
          content: assistant.content,
          tool_calls: assistant.toolCalls || undefined,
          refusal: null,
        },
        logprobs: null,
        finish_reason: assistant.finishReason,
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

function buildChatCompletionChunk({ id, created, model, delta, finishReason }) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    system_fingerprint: SYSTEM_FINGERPRINT,
    choices: [
      {
        index: 0,
        delta: delta || {},
        logprobs: null,
        finish_reason: finishReason ?? null,
      },
    ],
  };
}

function writeSse(res, data) {
  res.write(`data: ${data}\n\n`);
}

function writeSseJson(res, obj) {
  writeSse(res, JSON.stringify(obj));
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

  async function runConversationStream(userText, onDelta) {
    console.log(`\n[session:${sessionId}] [Q] ${userText}`);
    listener.clearPending?.();
    await sendMessage(userText);

    let finalResult = null;
    let finalError = null;
    receiveFinalResult().then(
      (final) => {
        finalResult = final;
      },
      (error) => {
        finalError = error;
      },
    );

    while (!finalResult && !finalError) {
      const delta = await listener.waitForNextDelta({ timeoutMs: 200 });
      if (delta && typeof onDelta === "function") onDelta(delta);
    }

    if (finalError) throw finalError;
    listener.cancelPendingDeltaWaiters?.();

    while (true) {
      const pending = await listener.waitForNextDelta({ timeoutMs: 0 });
      if (!pending) break;
      if (typeof onDelta === "function") onDelta(pending);
    }

    console.log(`[session:${sessionId}] [A] ${finalResult.text}`);
    return finalResult;
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

  function enqueueConversationStream(userText, onDelta) {
    const task = queue.then(() => runConversationStream(userText, onDelta));
    queue = task.catch(() => undefined);
    return task;
  }

  return {
    page,
    waitUntilReady,
    runConversation: enqueueConversation,
    runConversationStream: enqueueConversationStream,
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

function parseDeleteSessionId(urlPath) {
  if (!urlPath.startsWith("/v1/sessions/")) return null;
  const encodedId = urlPath.slice("/v1/sessions/".length);
  if (!encodedId) return null;
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return null;
  }
}

function createApiServer({
  port,
  context,
  conversationClient,
  defaultPage,
  createSessionFn = createSession,
}) {
  const sessions = new Map();
  sessions.set("default", {
    id: "default",
    created: Math.floor(Date.now() / 1000),
    chatUrl: CHAT_URL,
    page: defaultPage || null,
    conversationClient,
  });

  const server = http.createServer(async (req, res) => {
    const apiRequestId = makeId("api");
    const startedAt = Date.now();
    const remoteAddress = req.socket?.remoteAddress || null;
    const contentLengthHeader = req.headers["content-length"];
    const contentLength =
      typeof contentLengthHeader === "string"
        ? Number(contentLengthHeader)
        : null;

    logApi({
      type: "api.request",
      id: apiRequestId,
      method: req.method,
      url: req.url,
      remoteAddress,
      contentLength,
      userAgent:
        typeof req.headers["user-agent"] === "string"
          ? req.headers["user-agent"]
          : null,
    });

    res.on("finish", () => {
      logApi({
        type: "api.response",
        id: apiRequestId,
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    res.on("close", () => {
      if (res.writableEnded) return;
      logApi({
        type: "api.close",
        id: apiRequestId,
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    if (req.method === "GET" && req.url === "/health") {
      return jsonResponse(res, 200, { ok: true, sessions: sessions.size });
    }

    if (req.method === "POST" && req.url === "/v1/sessions") {
      try {
        const raw = await readRawBody(req);
        let body = {};
        try {
          body = parseJsonBody(raw);
        } catch (error) {
          logApi({
            type: "api.body",
            id: apiRequestId,
            endpoint: "/v1/sessions",
            parseOk: false,
            rawLength: raw.length,
            rawSnippet: API_LOG_BODY_SNIPPET
              ? safeSnippet(raw, API_LOG_BODY_MAX_CHARS)
              : undefined,
            message: error?.message || String(error),
          });
          return jsonResponse(res, 400, { error: "invalid json" });
        }

        logApi({
          type: "api.body",
          id: apiRequestId,
          endpoint: "/v1/sessions",
          parseOk: true,
          rawLength: raw.length,
          rawSnippet: API_LOG_BODY_SNIPPET
            ? safeSnippet(raw, API_LOG_BODY_MAX_CHARS)
            : undefined,
          hasChatUrl:
            typeof body?.chat_url === "string" && Boolean(body.chat_url),
        });
        const chatUrl =
          typeof body.chat_url === "string" ? body.chat_url : NEW_CHAT_URL;
        const session = await createSessionFn(context, chatUrl);
        sessions.set(session.id, session);
        return jsonResponse(res, 200, buildSessionResponse(session));
      } catch (error) {
        logApi({
          type: "api.error",
          id: apiRequestId,
          endpoint: "/v1/sessions",
          message: error?.message || String(error),
        });
        return jsonResponse(res, 500, {
          error: error?.message || String(error),
        });
      }
    }

    if (req.method === "DELETE") {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      const sessionId = parseDeleteSessionId(reqUrl.pathname);
      if (sessionId) {
        if (sessionId === "default") {
          try {
            const prev = sessions.get("default");
            const chatUrl = prev?.chatUrl || CHAT_URL;
            const page = await context.newPage();
            const listener = await attachConversationStreamListener(page, {
              debug: false,
            });
            await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
            const newDefaultClient = createPageConversationClient(
              page,
              listener,
              "default",
            );
            await newDefaultClient.waitUntilReady();
            sessions.set("default", {
              id: "default",
              created: Math.floor(Date.now() / 1000),
              chatUrl,
              page,
              conversationClient: newDefaultClient,
            });
            if (prev?.page && typeof prev.page.close === "function") {
              try {
                await prev.page.close();
              } catch (error) {
                logApi({
                  type: "api.error",
                  id: apiRequestId,
                  endpoint: "/v1/sessions/:id",
                  message: error?.message || String(error),
                  sessionId: "default",
                });
              }
            }
            return jsonResponse(res, 200, {
              id: "default",
              object: "session",
              deleted: true,
              reset: true,
            });
          } catch (error) {
            return jsonResponse(res, 500, {
              error: error?.message || String(error),
            });
          }
        }

        const session = sessions.get(sessionId);
        if (!session) {
          return jsonResponse(res, 404, {
            error: `session not found: ${sessionId}`,
          });
        }

        sessions.delete(sessionId);
        if (session.page && typeof session.page.close === "function") {
          try {
            await session.page.close();
          } catch (error) {
            logApi({
              type: "api.error",
              id: apiRequestId,
              endpoint: "/v1/sessions/:id",
              message: error?.message || String(error),
              sessionId,
            });
          }
        }

        return jsonResponse(res, 200, {
          id: sessionId,
          object: "session",
          deleted: true,
        });
      }
    }

    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      return jsonResponse(res, 404, { error: "not found" });
    }

    try {
      const raw = await readRawBody(req);
      let body = {};
      try {
        body = parseJsonBody(raw);
      } catch (error) {
        logApi({
          type: "api.body",
          id: apiRequestId,
          endpoint: "/v1/chat/completions",
          parseOk: false,
          rawLength: raw.length,
          rawSnippet: API_LOG_BODY_SNIPPET
            ? safeSnippet(raw, API_LOG_BODY_MAX_CHARS)
            : undefined,
          message: error?.message || String(error),
        });
        await logChatCompletionRequest({
          apiRequestId,
          endpoint: "/v1/chat/completions",
          raw,
          body: null,
          parseOk: false,
        });
        return jsonResponse(res, 400, { error: "invalid json" });
      }

      await logChatCompletionRequest({
        apiRequestId,
        endpoint: "/v1/chat/completions",
        raw,
        body,
        parseOk: true,
      });

      const userText = buildWebPromptFromOpenAiBody(body);
      const sessionId =
        typeof body.session_id === "string" && body.session_id
          ? body.session_id
          : "default";

      logApi({
        type: "api.body",
        id: apiRequestId,
        endpoint: "/v1/chat/completions",
        parseOk: true,
        rawLength: raw.length,
        rawSnippet: API_LOG_BODY_SNIPPET
          ? safeSnippet(raw, API_LOG_BODY_MAX_CHARS)
          : undefined,
        model: typeof body?.model === "string" ? body.model : null,
        stream: Boolean(body?.stream),
        sessionId,
        messagesCount: Array.isArray(body?.messages)
          ? body.messages.length
          : null,
        toolsCount: Array.isArray(body?.tools) ? body.tools.length : 0,
        tools: summarizeToolsForLog(body?.tools),
        toolChoice: summarizeToolChoiceForLog(body?.tool_choice),
        includeToolsInWebPrompt: INCLUDE_TOOLS_IN_WEB_PROMPT,
        onlyLastMessageInWebPrompt: ONLY_LAST_MESSAGE_IN_WEB_PROMPT,
        promptTokens: estimatePromptTokens(body?.messages),
        userText: API_LOG_USER_TEXT ? safeSnippet(userText, 240) : undefined,
        userTextLength: userText.length,
      });

      if (!userText) {
        logApi({
          type: "api.reject",
          id: apiRequestId,
          endpoint: "/v1/chat/completions",
          reason: "missing user message",
        });
        return jsonResponse(res, 400, { error: "missing user message" });
      }

      const session = sessions.get(sessionId);
      if (!session) {
        logApi({
          type: "api.reject",
          id: apiRequestId,
          endpoint: "/v1/chat/completions",
          reason: "session not found",
          sessionId,
        });
        return jsonResponse(res, 404, {
          error: `session not found: ${sessionId}`,
        });
      }

      if (body.stream === true) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });

        const created = Math.floor(Date.now() / 1000);
        const id = `chatcmpl-${Date.now()}`;
        const model = body.model || DEFAULT_MODEL;

        writeSseJson(
          res,
          buildChatCompletionChunk({
            id,
            created,
            model,
            delta: { role: "assistant" },
          }),
        );

        let isClosed = false;
        res.on("close", () => {
          isClosed = true;
        });

        let streamedText = "";
        const result = await session.conversationClient.runConversationStream(
          userText,
          STREAM_REALTIME_DELTAS
            ? (delta) => {
                streamedText += delta;
                if (isClosed) return;
                if (!delta) return;
                writeSseJson(
                  res,
                  buildChatCompletionChunk({
                    id,
                    created,
                    model,
                    delta: { content: delta },
                  }),
                );
              }
            : null,
        );

        const assistant = buildAssistantMessageFromResult(result);
        if (!isClosed && assistant.content) {
          let finalDelta = "";
          if (!STREAM_REALTIME_DELTAS || streamedText.length === 0) {
            finalDelta = assistant.content;
          } else if (assistant.content.startsWith(streamedText)) {
            finalDelta = assistant.content.slice(streamedText.length);
          } else if (streamedText !== assistant.content) {
            logApi({
              type: "api.stream_mismatch",
              id: apiRequestId,
              streamedLength: streamedText.length,
              finalLength: assistant.content.length,
              streamedText: API_LOG_USER_TEXT
                ? safeSnippet(streamedText, 240)
                : undefined,
              finalText: API_LOG_USER_TEXT
                ? safeSnippet(assistant.content, 240)
                : undefined,
            });
          }

          if (finalDelta) {
            writeSseJson(
              res,
              buildChatCompletionChunk({
                id,
                created,
                model,
                delta: { content: finalDelta },
              }),
            );
          }
        }

        if (!isClosed && assistant.toolCalls) {
          writeSseJson(
            res,
            buildChatCompletionChunk({
              id,
              created,
              model,
              delta: { tool_calls: assistant.toolCalls },
            }),
          );
        }

        if (!isClosed) {
          writeSseJson(
            res,
            buildChatCompletionChunk({
              id,
              created,
              model,
              delta: {},
              finishReason: assistant.finishReason,
            }),
          );
          writeSse(res, "[DONE]");
          res.end();
        }

        return;
      }

      const result = await session.conversationClient.runConversation(userText);
      return jsonResponse(
        res,
        200,
        buildChatCompletionResponse({ body, result }),
      );
    } catch (error) {
      logApi({
        type: "api.error",
        id: apiRequestId,
        endpoint: "/v1/chat/completions",
        message: error?.message || String(error),
      });
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
  createApiServer({
    port: PORT,
    context,
    conversationClient,
    defaultPage: page,
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[fatal]", error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  createApiServer,
  createSession,
  createPageConversationClient,
  buildWebPromptFromOpenAiBody,
  logChatCompletionRequest,
};
