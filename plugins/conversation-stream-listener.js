function attachConversationStreamListener(target, options = {}) {
  const targetPattern =
    options.targetPattern || /\/backend-api\/f\/conversation(?:$|[/?#])/;
  const wsPattern =
    options.wsPattern || /chatgpt\.com|chat\.openai\.com|\/backend-api\//;
  const debug = Boolean(options.debug);
  const printFinal = Boolean(options.printFinal);
  const onFinalResponse =
    typeof options.onFinalResponse === "function" ? options.onFinalResponse : null;

  const streamState = {
    lastRealtimeOutputAt: 0,
    streams: new Map(),
    pendingFinalTexts: [],
    waiters: [],
  };

  attachFetchStreamListener(target, targetPattern, streamState, debug, {
    printFinal,
    onFinalResponse,
  });

  target.on("request", async (request) => {
    const url = request.url();
    if (!targetPattern.test(url)) return;

    const body = request.postData() || "";
    const q = extractUserText(body);
    if (q) console.log(`\n[Q] ${q}`);
  });

  // HTTP fallback when page-side realtime stream capture fails.
  target.on("response", async (response) => {
    const url = response.url();
    if (!targetPattern.test(url)) return;

    try {
      const bodyText = await response.text();
      if (Date.now() - streamState.lastRealtimeOutputAt < 5000) return;

      const events = parseSseEvents(bodyText);
      let finalText = "";

      for (const evt of events) {
        const text = extractAssistantTextFromEvent(evt);
        if (!text) continue;
        finalText += text;
      }

      if (finalText.trim()) {
        emitFinalResponse(finalText, streamState, {
          printFinal,
          onFinalResponse,
          source: "response-fallback",
        });
      }
    } catch (error) {
      console.error("[stream][error]", error.message || error);
    }
  });

  target.on("websocket", (ws) => {
    const wsUrl = ws.url();
    if (!wsPattern.test(wsUrl)) return;

    ws.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;

      const events = parseSseEvents(payload);
      let frameText = "";
      for (const evt of events) {
        const text = extractAssistantTextFromEvent(evt);
        if (!text) continue;
        frameText += text;
      }

      if (frameText) streamState.lastRealtimeOutputAt = Date.now();
    });
  });

  return {
    waitForNextFinalResponse: ({ timeoutMs = 120000 } = {}) =>
      waitForNextFinalResponse(streamState, timeoutMs),
  };
}

async function attachFetchStreamListener(
  target,
  targetPattern,
  streamState,
  debug,
  emitOptions,
) {
  try {
    if (!target.exposeBinding || !target.addInitScript) return;

    const bindingName = "__conversationStreamListenerChunk";

    await target.exposeBinding(bindingName, (_source, payload) => {
      handleRealtimePayload(payload, streamState, emitOptions);
    });

    await target.addInitScript(
      ({ bindingName: pageBindingName, patternSource, patternFlags }) => {
        if (window.__conversationStreamListenerInstalled) return;
        window.__conversationStreamListenerInstalled = true;

        const targetPatternInPage = new RegExp(patternSource, patternFlags);
        const originalFetch = window.fetch;

        window.fetch = async function patchedFetch(input, init) {
          const response = await originalFetch.apply(this, arguments);

          try {
            const url =
              (typeof input === "string" ? input : input?.url) ||
              response.url ||
              "";

            if (!targetPatternInPage.test(url) || !response.body) return response;

            const streamId = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
            const cloned = response.clone();
            const reader = cloned.body.getReader();
            const decoder = new TextDecoder();

            window[pageBindingName]({ type: "start", id: streamId, url });

            (async () => {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const text = decoder.decode(value, { stream: true });
                if (text) {
                  window[pageBindingName]({
                    type: "chunk",
                    id: streamId,
                    url,
                    text,
                  });
                }
              }

              const tail = decoder.decode();
              if (tail) {
                window[pageBindingName]({
                  type: "chunk",
                  id: streamId,
                  url,
                  text: tail,
                });
              }

              window[pageBindingName]({ type: "done", id: streamId, url });
            })().catch((error) => {
              window[pageBindingName]({
                type: "error",
                id: streamId,
                url,
                message: error?.message || String(error),
              });
            });
          } catch (error) {
            window[pageBindingName]({
              type: "error",
              id: "setup",
              message: error?.message || String(error),
            });
          }

          return response;
        };
      },
      {
        bindingName,
        patternSource: targetPattern.source,
        patternFlags: targetPattern.flags.replace(/[gy]/g, ""),
      },
    );
    if (debug) console.log("[stream][debug] fetch stream hook installed");
  } catch (error) {
    if (debug) console.error("[stream][debug] fetch stream hook failed", error);
  }
}

function handleRealtimePayload(payload, streamState, emitOptions) {
  if (!payload || typeof payload !== "object") return;

  if (payload.type === "start") {
    streamState.streams.set(payload.id, {
      buffer: "",
      fullText: "",
    });
    return;
  }

  const state = streamState.streams.get(payload.id);
  if (!state) return;

  if (payload.type === "chunk") {
    consumeSseChunk(state, payload.text || "", streamState);
    return;
  }

  if (payload.type === "done" || payload.type === "error") {
    consumeSseChunk(state, "\n\n", streamState);

    if (state.fullText.trim()) {
      emitFinalResponse(state.fullText, streamState, {
        ...emitOptions,
        source: payload.type,
      });
    }

    streamState.streams.delete(payload.id);
  }
}

function consumeSseChunk(state, chunk, streamState) {
  if (!chunk) return;

  state.buffer += chunk;

  while (true) {
    const boundary = findSseBoundary(state.buffer);
    if (!boundary) break;

    const block = state.buffer.slice(0, boundary.index);
    state.buffer = state.buffer.slice(boundary.end);

    const events = parseSseEvents(block);
    for (const evt of events) {
      const text = extractAssistantTextFromEvent(evt);
      if (!text) continue;

      state.fullText += text;
      streamState.lastRealtimeOutputAt = Date.now();
    }
  }
}

function emitFinalResponse(text, streamState, options = {}) {
  const finalText = (text || "").trim();
  if (!finalText) return;

  if (options.printFinal) console.log(`[A] ${finalText}`);
  if (typeof options.onFinalResponse === "function") {
    options.onFinalResponse(finalText, { source: options.source || "unknown" });
  }

  const waiter = streamState.waiters.shift();
  if (waiter) {
    waiter.resolve({ text: finalText });
    return;
  }

  streamState.pendingFinalTexts.push(finalText);
}

function waitForNextFinalResponse(streamState, timeoutMs) {
  if (streamState.pendingFinalTexts.length > 0) {
    const text = streamState.pendingFinalTexts.shift();
    return Promise.resolve({ text });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = streamState.waiters.findIndex((w) => w.resolve === resolve);
      if (idx >= 0) streamState.waiters.splice(idx, 1);
      reject(new Error(`waitForNextFinalResponse timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    streamState.waiters.push({
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
    });
  });
}

function findSseBoundary(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");

  if (lf === -1 && crlf === -1) return null;
  if (lf === -1) return { index: crlf, end: crlf + 4 };
  if (crlf === -1) return { index: lf, end: lf + 2 };

  return lf < crlf
    ? { index: lf, end: lf + 2 }
    : { index: crlf, end: crlf + 4 };
}

function parseSseEvents(raw) {
  if (!raw || typeof raw !== "string") return [];

  const blocks = raw.split(/\r?\n\r?\n/);
  const out = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let eventType = "message";
    const dataLines = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith(":")) continue;

      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim() || "message";
        continue;
      }

      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") continue;

    out.push({ event: eventType, data });
  }

  return out;
}

function extractAssistantTextFromEvent(evt) {
  if (!evt || typeof evt.data !== "string") return "";

  if (evt.event !== "delta" && evt.event !== "message") return "";

  try {
    const payload = JSON.parse(evt.data);
    return extractTextFromDeltaLike(payload);
  } catch {
    return "";
  }
}

function extractTextFromDeltaLike(obj) {
  if (!obj || typeof obj !== "object") return "";

  if (typeof obj.v === "string") return obj.v;

  if (obj.o === "append" && typeof obj.v === "string") return obj.v;

  if (obj.o === "patch" && Array.isArray(obj.v)) {
    let acc = "";
    for (const op of obj.v) {
      if (op?.o === "append" && typeof op?.v === "string") acc += op.v;
    }
    return acc;
  }

  if (obj.delta && typeof obj.delta === "object") {
    const t = extractTextFromDeltaLike(obj.delta);
    if (t) return t;
  }

  if (obj.message?.author?.role === "assistant") {
    const t = flattenText(obj.message?.content?.parts);
    if (t) return t;
  }

  if (obj.v?.message?.author?.role === "assistant") {
    const t = flattenText(obj.v?.message?.content?.parts);
    if (t) return t;
  }

  return "";
}

function extractUserText(rawBody) {
  try {
    const body = JSON.parse(rawBody);
    const msg = Array.isArray(body?.messages)
      ? [...body.messages].reverse().find((m) => m?.author?.role === "user")
      : null;
    if (!msg) return "";

    return (
      flattenText(msg?.content?.parts) ||
      (typeof msg?.content?.text === "string" ? msg.content.text : "")
    );
  } catch {
    return "";
  }
}

function flattenText(parts) {
  if (!Array.isArray(parts)) return "";

  const out = [];
  for (const part of parts) {
    if (typeof part === "string") {
      out.push(part);
      continue;
    }

    if (!part || typeof part !== "object") continue;

    if (typeof part.text === "string") out.push(part.text);
    if (typeof part.content === "string") out.push(part.content);
    if (Array.isArray(part.parts)) out.push(flattenText(part.parts));
  }

  return out.join("");
}

module.exports = {
  attachConversationStreamListener,
};
