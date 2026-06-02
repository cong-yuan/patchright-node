# Patchright OpenAI-Compatible API Guide

## 1. 概述
本服务通过浏览器页面驱动 ChatGPT Web，实现 OpenAI 风格接口：
- `POST /v1/sessions`：创建新页面会话（new session）
- `POST /v1/chat/completions`：发送对话并获取最终回答（非流式）
- `GET /health`：健康检查

默认监听地址：`http://127.0.0.1:8787`

## 2. 启动服务
```bash
node /Volumes/Code/caixun/spp-test/patchright-node/index.js
```

可选环境变量：
- `PORT`：端口（默认 `8787`）
- `CHAT_URL`：默认会话页面 URL
- `NEW_CHAT_URL`：新会话默认页面 URL（`/v1/sessions` 未传 `chat_url` 时使用）
- `MODEL_NAME`：默认模型名（响应 `model` 回退值）
- `SYSTEM_FINGERPRINT`：响应中的 `system_fingerprint`
- `ONLY_LAST_MESSAGE_IN_WEB_PROMPT`：是否只把最后一个消息传到页面，默认 `1`。兼容旧变量 `ONLY_LAST_USER_MESSAGE_IN_WEB_PROMPT`
- `INCLUDE_TOOLS_IN_WEB_PROMPT`：是否把 `tools` / `tool_choice` 注入到页面 prompt 中，默认 `1`
- `CHAT_COMPLETION_REQUEST_LOG_FILE`：`/v1/chat/completions` 的本地 JSONL 日志路径，默认 `./logs/chat-completions.jsonl`

---

## 3. 接口说明

## 3.1 GET /health
健康检查。

### 请求
```bash
curl -s http://127.0.0.1:8787/health | jq
```

### 响应示例
```json
{
  "ok": true,
  "sessions": 1
}
```

---

## 3.2 POST /v1/sessions
创建一个新的页面会话，并返回 `session_id`。

### 请求体
- `chat_url` (string, optional): 新会话要打开的页面地址。默认 `NEW_CHAT_URL`。

### 请求示例（最简）
```bash
curl -s -X POST http://127.0.0.1:8787/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{}' | jq
```

### 请求示例（指定 chat_url）
```bash
curl -s -X POST http://127.0.0.1:8787/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{"chat_url":"https://chatgpt.com/"}' | jq
```

### 响应示例
```json
{
  "id": "sess_1748770000000_ab12cd",
  "object": "session",
  "created": 1748770000,
  "status": "ready",
  "chat_url": "https://chatgpt.com/"
}
```

---

## 3.3 DELETE /v1/sessions/{session_id}
删除一个已创建的会话。

### 说明
- 删除普通 session：关闭其页面并移除会话。
- 删除 `default`：会重建一个全新的 `default` 会话，返回 `200` 与 `reset: true`。
- 如果 `session_id` 不存在，返回 `404`。

### 请求示例
```bash
curl -s -X DELETE "http://127.0.0.1:8787/v1/sessions/${SESSION_ID}" | jq
```

### 响应示例
```json
{
  "id": "sess_1748770000000_ab12cd",
  "object": "session",
  "deleted": true
}
```

### 删除 default 响应示例
```json
{
  "id": "default",
  "object": "session",
  "deleted": true,
  "reset": true
}
```

---

## 3.4 POST /v1/chat/completions
OpenAI 风格非流式聊天接口。输入用户消息，返回最终完整答案。

## 4. 请求字段
- `model` (string, optional)
- `session_id` (string, optional): 指定会话。未传时使用 `default`。
- `stream` (boolean, optional): **仅支持 `false` 或不传**。传 `true` 会返回 400。
- `messages` (array, required): OpenAI 风格消息数组。会提取最后一条 `role=user` 消息发送。

消息示例：
```json
[
  {"role":"system","content":"你是一个简洁助手"},
  {"role":"user","content":"你好"}
]
```

---

## 5. 调用案例（curl）

## 5.1 使用 default 会话
```bash
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "messages": [
      {"role":"user","content":"用一句话解释事件循环"}
    ]
  }' | jq
```

## 5.2 先创建 session，再带 session_id 对话
```bash
SESSION_JSON=$(curl -s -X POST http://127.0.0.1:8787/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{}')

SESSION_ID=$(echo "$SESSION_JSON" | jq -r '.id')
echo "SESSION_ID=$SESSION_ID"

curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"gpt-5\",
    \"session_id\": \"${SESSION_ID}\",
    \"messages\": [
      {\"role\":\"user\",\"content\":\"你好，介绍一下你自己\"}
    ]
  }" | jq
```

## 5.3 指定不存在的 session_id
```bash
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "sess_not_exists",
    "messages": [
      {"role":"user","content":"hello"}
    ]
  }' | jq
```

预期：`404`，`{"error":"session not found: sess_not_exists"}`

## 5.4 传 stream=true（不支持）
```bash
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "stream": true,
    "messages": [
      {"role":"user","content":"hello"}
    ]
  }' | jq
```

预期：`400`，`stream=true is not supported`

---

## 6. 成功响应结构（示例）
```json
{
  "id": "401b0371-8b33-424d-8c9d-52a6aa606be2",
  "object": "chat.completion",
  "created": 1748770123,
  "model": "gpt-5-5",
  "system_fingerprint": "fp_patchright_node_proxy_v1",
  "service_tier": "default",
  "conversation_id": "6a1d022c-6500-83ec-92eb-2c43bbd4bc34",
  "request_id": "c03630f0-a340-4d61-a5fc-e0846d47ba6f",
  "turn_exchange_id": "01aa9e95-9341-4960-9189-bf679f86d98c",
  "turn_trace_id": "ae6a0b5e-2bf0-4299-b511-bbf6273aa41f",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "你好呀！很高兴见到你。",
        "refusal": null
      },
      "logprobs": null,
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 8,
    "completion_tokens": 12,
    "total_tokens": 20,
    "prompt_tokens_details": {
      "cached_tokens": 0,
      "audio_tokens": 0
    },
    "completion_tokens_details": {
      "reasoning_tokens": 0,
      "audio_tokens": 0,
      "accepted_prediction_tokens": 0,
      "rejected_prediction_tokens": 0
    }
  }
}
```

说明：
- `usage` 当前为估算值（按字符长度近似），不是 tokenizer 精确值。
- `conversation_id/request_id/...` 为扩展字段，便于追踪会话与链路。

---

## 7. 常见错误
- `400 missing user message`：`messages` 里没有可提取的 `role=user` 文本。
- `400 stream=true is not supported`：当前仅支持最终结果，不支持流式。
- `404 session not found`：`session_id` 不存在。
- `500 ...`：页面未就绪、网络异常、超时等内部错误。

---

## 8. 快速联调脚本
```bash
BASE=http://127.0.0.1:8787

# create session
SID=$(curl -s -X POST "$BASE/v1/sessions" -H 'Content-Type: application/json' -d '{}' | jq -r '.id')
echo "SID=$SID"

# chat
curl -s -X POST "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SID\",\"messages\":[{\"role\":\"user\",\"content\":\"请用两句话介绍Node.js事件循环\"}]}" | jq
```
