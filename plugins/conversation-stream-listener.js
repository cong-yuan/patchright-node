function attachConversationStreamListener(target, options = {}) {
  const targetPattern =
    options.targetPattern || /\/backend-api\/f\/conversation(?:$|[/?#])/;
  const wsPattern =
    options.wsPattern || /chatgpt\.com|chat\.openai\.com|\/backend-api\//;

  const streamState = {
    lastRealtimeOutputAt: 0,
    streams: new Map(),
    pendingDeltas: [],
    deltaWaiters: [],
    pendingFinalResponses: [],
    waiters: [],
  };

  attachFetchStreamListener(target, targetPattern, streamState);

  target.on("response", async (response) => {
    const url = response.url();
    if (!targetPattern.test(url)) return;

    try {
      const bodyText = await response.text();
      if (Date.now() - streamState.lastRealtimeOutputAt < 5000) return;

      const events = parseSseEvents(bodyText);
      const state = createStreamState();
      for (const evt of events) consumeSseEvent(state, evt, streamState);

      if (state.fullText.trim()) emitFinalResponse(buildFinalResult(state), streamState);
    } catch {}
  });

  target.on("websocket", (ws) => {
    const wsUrl = ws.url();
    if (!wsPattern.test(wsUrl)) return;

    ws.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;

      const events = parseSseEvents(payload);
      for (const evt of events) {
        const text = extractAssistantTextFromEvent(evt);
        if (text) streamState.lastRealtimeOutputAt = Date.now();
      }
    });
  });

  return {
    waitForNextFinalResponse: ({ timeoutMs = 120000 } = {}) =>
      waitForNextFinalResponse(streamState, timeoutMs),
    waitForNextDelta: ({ timeoutMs = 2000 } = {}) =>
      waitForNextDelta(streamState, timeoutMs),
    cancelPendingDeltaWaiters: () => cancelPendingDeltaWaiters(streamState),
    clearPending: () => clearPending(streamState),
  };
}

function createStreamState() {
  return {
    buffer: "",
    fullText: "",
    meta: {
      conversationId: null,
      inputMessageId: null,
      assistantMessageId: null,
      requestId: null,
      turnExchangeId: null,
      turnTraceId: null,
      resolvedModelSlug: null,
      modelSlug: null,
      finishReason: null,
    },
  };
}

async function attachFetchStreamListener(target, targetPattern, streamState) {
  try {
    if (!target.exposeBinding || !target.addInitScript) return;

    const bindingName = "__conversationStreamListenerChunk";

    await target.exposeBinding(bindingName, (_source, payload) => {
      handleRealtimePayload(payload, streamState);
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
                  window[pageBindingName]({ type: "chunk", id: streamId, url, text });
                }
              }

              const tail = decoder.decode();
              if (tail) {
                window[pageBindingName]({ type: "chunk", id: streamId, url, text: tail });
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
  } catch {}
}

function handleRealtimePayload(payload, streamState) {
  if (!payload || typeof payload !== "object") return;

  if (payload.type === "start") {
    streamState.streams.set(payload.id, createStreamState());
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
    if (state.fullText.trim()) emitFinalResponse(buildFinalResult(state), streamState);
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
    for (const evt of events) consumeSseEvent(state, evt, streamState);
  }
}

function consumeSseEvent(state, evt, streamState) {
  const text = extractAssistantTextFromEvent(evt);
  if (text) {
    state.fullText += text;
    streamState.lastRealtimeOutputAt = Date.now();
    emitDelta(text, streamState);
  }

  const metaPatch = extractMetaFromEvent(evt);
  mergeMeta(state.meta, metaPatch);
}

function extractMetaFromEvent(evt) {
  if (!evt || typeof evt.data !== "string") return {};

  let payload;
  try {
    payload = JSON.parse(evt.data);
  } catch {
    return {};
  }

  const meta = {};

  if (typeof payload.conversation_id === "string") {
    meta.conversationId = payload.conversation_id;
  }

  if (payload.type === "input_message" && payload.input_message) {
    if (typeof payload.input_message.id === "string") {
      meta.inputMessageId = payload.input_message.id;
    }

    const md = payload.input_message.metadata;
    if (md && typeof md === "object") {
      if (typeof md.request_id === "string") meta.requestId = md.request_id;
      if (typeof md.turn_exchange_id === "string") {
        meta.turnExchangeId = md.turn_exchange_id;
      }
      if (typeof md.turn_trace_id === "string") meta.turnTraceId = md.turn_trace_id;
      if (typeof md.resolved_model_slug === "string") {
        meta.resolvedModelSlug = md.resolved_model_slug;
      }
    }
  }

  if (payload.type === "server_ste_metadata" && payload.metadata) {
    const md = payload.metadata;
    if (typeof md.request_id === "string") meta.requestId = md.request_id;
    if (typeof md.turn_exchange_id === "string") meta.turnExchangeId = md.turn_exchange_id;
    if (typeof md.turn_trace_id === "string") meta.turnTraceId = md.turn_trace_id;
    if (typeof md.model_slug === "string") meta.modelSlug = md.model_slug;
  }

  if (payload?.v?.message && typeof payload.v.message === "object") {
    const msg = payload.v.message;
    if (typeof msg.id === "string") meta.assistantMessageId = msg.id;

    const md = msg.metadata;
    if (md && typeof md === "object") {
      if (typeof md.request_id === "string") meta.requestId = md.request_id;
      if (typeof md.turn_exchange_id === "string") meta.turnExchangeId = md.turn_exchange_id;
      if (typeof md.model_slug === "string") meta.modelSlug = md.model_slug;
      if (typeof md.resolved_model_slug === "string") {
        meta.resolvedModelSlug = md.resolved_model_slug;
      }
    }
  }

  if (payload.o === "patch" && Array.isArray(payload.v)) {
    for (const op of payload.v) {
      if (op?.p === "/message/status" && op?.v === "finished_successfully") {
        meta.finishReason = "stop";
      }
      if (op?.p === "/message/metadata" && op?.o === "append") {
        const finishType = op?.v?.finish_details?.type;
        if (typeof finishType === "string") meta.finishReason = normalizeFinishReason(finishType);
      }
    }
  }

  if (payload.type === "message_stream_complete" && !meta.finishReason) {
    meta.finishReason = "stop";
  }

  return meta;
}

function mergeMeta(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== null && value !== undefined && value !== "") target[key] = value;
  }
}

function normalizeFinishReason(raw) {
  if (raw === "stop") return "stop";
  if (raw === "length") return "length";
  if (raw === "content_filter") return "content_filter";
  if (raw === "tool_calls") return "tool_calls";
  return "stop";
}

function buildFinalResult(state) {
  const meta = state.meta || {};
  return {
    text: (state.fullText || "").trim(),
    conversationId: meta.conversationId || null,
    inputMessageId: meta.inputMessageId || null,
    assistantMessageId: meta.assistantMessageId || null,
    requestId: meta.requestId || null,
    turnExchangeId: meta.turnExchangeId || null,
    turnTraceId: meta.turnTraceId || null,
    resolvedModelSlug: meta.resolvedModelSlug || null,
    modelSlug: meta.modelSlug || null,
    finishReason: meta.finishReason || "stop",
  };
}

function emitFinalResponse(finalResponse, streamState) {
  if (!finalResponse || !finalResponse.text) return;

  const waiter = streamState.waiters.shift();
  if (waiter) {
    waiter.resolve(finalResponse);
    return;
  }

  streamState.pendingFinalResponses.push(finalResponse);
}

function emitDelta(deltaText, streamState) {
  if (!deltaText) return;

  const waiter = streamState.deltaWaiters.shift();
  if (waiter) {
    waiter.resolve(deltaText);
    return;
  }

  streamState.pendingDeltas.push(deltaText);
}

function waitForNextFinalResponse(streamState, timeoutMs) {
  if (streamState.pendingFinalResponses.length > 0) {
    return Promise.resolve(streamState.pendingFinalResponses.shift());
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

function waitForNextDelta(streamState, timeoutMs) {
  if (streamState.pendingDeltas.length > 0) {
    return Promise.resolve(streamState.pendingDeltas.shift());
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const idx = streamState.deltaWaiters.findIndex((w) => w.resolve === resolve);
      if (idx >= 0) streamState.deltaWaiters.splice(idx, 1);
      resolve(null);
    }, timeoutMs);

    streamState.deltaWaiters.push({
      timer,
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
    });
  });
}

function clearPending(streamState) {
  streamState.pendingDeltas.length = 0;
  streamState.pendingFinalResponses.length = 0;
  cancelPendingDeltaWaiters(streamState);
}

function cancelPendingDeltaWaiters(streamState) {
  const deltaWaiters = streamState.deltaWaiters.splice(0);
  for (const waiter of deltaWaiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(null);
  }
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

      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
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
