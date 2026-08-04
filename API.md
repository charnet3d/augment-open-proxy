# API Endpoints

## `GET /v1/models`

Returns a list of available Augment models in the OpenAI models format.

**Response:**
```json
{
  "object": "list",
  "data": [
    { "id": "claude-sonnet-4-5", "object": "model", "owned_by": "augment" }
  ]
}
```

## `POST /v1/chat/completions`

Creates a chat completion. Accepts the standard OpenAI request body.

**Request body:**
```json
{
  "model": "claude-sonnet-4-5",
  "messages": [
    { "role": "user", "content": "Explain TypeScript generics." }
  ],
  "stream": true
}
```

**Response (streaming):** SSE stream of `chat.completion.chunk` events.

**Response (non-streaming):** Standard OpenAI `CreateChatCompletionResponse`.

### Tool calling

Tool calling (function calling) is supported via the Augment SDK:

```json
{
  "model": "claude-sonnet-4-5",
  "messages": [
    { "role": "user", "content": "What's the weather in SF?" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather",
        "parameters": {
          "type": "object",
          "properties": {
            "location": { "type": "string" }
          },
          "required": ["location"]
        }
      }
    }
  ]
}
```

## `POST /v1/responses`

OpenAI Responses API endpoint. Accepts the Responses-API request body and
returns either a `ResponseObject` (non-streaming) or the standard Responses-API
SSE event sequence (streaming).

**Request body:**
```json
{
  "model": "claude-sonnet-4-5",
  "input": [
    { "role": "user", "content": "Explain TypeScript generics." }
  ],
  "stream": true
}
```

The `input` field accepts either a plain string or an array of input items
(`message`, `function_call`, `function_call_output`, `reasoning`). The
optional `instructions` field sets a system prompt.

**Response (non-streaming):** A `ResponseObject` with `output` containing
`message`, `function_call`, and/or `reasoning` output items.

**Response (streaming):** Responses-API SSE event sequence —
`response.created` → `response.in_progress` → `response.output_item.added`
→ content/argument deltas (`response.output_text.delta`,
`response.reasoning_summary_text.delta`, `response.function_call_arguments.delta`)
→ `response.output_item.done` → `response.completed`.

**Tool calling:**
```json
{
  "model": "claude-sonnet-4-5",
  "input": [{ "role": "user", "content": "What's the weather in SF?" }],
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "Get the current weather",
      "parameters": {
        "type": "object",
        "properties": { "location": { "type": "string" } },
        "required": ["location"]
      }
    }
  ]
}
```

Note: unlike the Chat Completions API, Responses-API tools use a **flat**
shape — `name`, `description`, and `parameters` are top-level fields, not
nested under a `function` key.

**Reasoning** (`reasoning.effort` / `reasoning.summary`):
```json
{
  "model": "claude-opus-4-7",
  "input": [{ "role": "user", "content": "Plan a refactor of foo()." }],
  "reasoning": { "effort": "high", "summary": "concise" }
}
```

## `POST /v1/messages`

Anthropic-compatible Messages API endpoint, suitable for Claude Code and the
official `@anthropic-ai/sdk` client. Accepts the standard Anthropic request
body (`model`, `messages`, `system`, `tools`, `tool_choice`, `max_tokens`,
`temperature`, `top_p`, `top_k`, `stop_sequences`, `thinking`, `stream`).

**Request body:**
```json
{
  "model": "claude-sonnet-4-5",
  "max_tokens": 1024,
  "messages": [
    { "role": "user", "content": "Explain TypeScript generics." }
  ],
  "stream": true
}
```

**Response (non-streaming):** Standard Anthropic `Message` envelope with
`content` blocks (`text`, `tool_use`, `thinking`), `stop_reason`, and `usage`.

**Response (streaming):** Anthropic SSE event sequence — `message_start` →
`content_block_start` / `content_block_delta` (`text_delta`,
`input_json_delta`, `thinking_delta`) / `content_block_stop` →
`message_delta` → `message_stop`.

**Extended thinking.** Pass `"thinking": { "type": "enabled",
"budget_tokens": N }` to map onto Augment's effort tiers (≤4096 → low,
≤16384 → medium, >16384 → high). When the registry advertises the
corresponding effort level for the requested base model, the request is
forwarded to the suffixed model ID (e.g. `claude-opus-4-7-high`) and the
response echoes the original base model.

## `POST /v1/messages/count_tokens`

Returns an estimated `input_tokens` count for a given message payload. The
Augment backend does not expose an exact counter, so this uses a 4-chars-
per-token heuristic — sufficient for budgeting / progress UIs but not for
billing-grade accuracy.

## Reasoning effort

Augment encodes reasoning depth in the model ID itself: a base model like
`claude-opus-4-7` exposes suffixed variants (`-low`, `-medium`, `-high`,
`-max`, `-xhigh`) when the upstream advertises them. The proxy supports
both forms:

1. **Suffixed model ID directly.** Every advertised variant appears as its
   own entry in `GET /v1/models`. Pass it as `model` and you get that
   reasoning depth — e.g. `"model": "claude-opus-4-7-high"`.
2. **OpenAI `reasoning_effort` on the base ID.** Send the base model with a
   standard OpenAI `reasoning_effort` (`none` | `minimal` | `low` | `medium`
   | `high` | `xhigh`) and the proxy rewrites the request to the suffixed
   backend ID before forwarding. The response echoes the original (base)
   `model` ID.

```json
{
  "model": "claude-opus-4-7",
  "messages": [{ "role": "user", "content": "Plan a refactor of foo()." }],
  "reasoning_effort": "high"
}
```

The Responses-API nested form is also accepted:
`"reasoning": { "effort": "medium", "summary": "concise" }`. When both forms
are set, the nested one wins.

**Mapping rules.** Exact (case-insensitive) matches win. `none` is forwarded
to the base model with no depth suffix (use it to opt out of reasoning).
`minimal` is treated as `low` (Augment has no minimal tier). `xhigh` matches
Augment's `xhigh` tier directly. Otherwise the requested level snaps to the
closest advertised level by index in `["low","medium","high","max","xhigh"]`
— so requesting `high` on a model that only advertises `["low","medium",
"max"]` resolves to `max`, and `xhigh` on a model without it snaps to `max`.

If a model has no advertised effort levels, `reasoning_effort` is forwarded
to the SDK as a `providerOptions.augment.reasoningEffort` hint and the
model ID is left untouched.

### Disabling effort variants per model

Some models advertise effort levels in the CLI but currently 404 on the
backend when the suffixed ID is sent (observed for `claude-opus-4-6` —
likely an entitlement/rollout gap). Suppress all effort variants for a base
model, or only selected variants, with `AOP_DISABLE_EFFORT_MODELS`:

```env
AOP_DISABLE_EFFORT_MODELS=claude-opus-4-6
# or, equivalently, using CLI short names:
AOP_DISABLE_EFFORT_MODELS=opus4.6,sonnet4.6
# disable only selected levels; the base model and other levels remain usable:
AOP_DISABLE_EFFORT_MODELS=claude-opus-4-7-low,opus4.7-xhigh
```

Entries are comma- or whitespace-separated. Bare base IDs disable all
advertised levels; IDs with an effort suffix (`low`, `medium`, `high`, `max`,
or `xhigh`) disable only that level. In both cases, the base model remains
available.

Listed models still appear in `/v1/models` under their base ID. Disabled
suffixed variants are hidden, and `reasoning_effort` requests that resolve to
those variants are a no-op (the request is sent as-is to the base model).

## Image input (experimental)

Image input is supported via the standard OpenAI `image_url` content part:

```json
{
  "model": "claude-sonnet-4-5",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What's in this image?" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
      ]
    }
  ]
}
```

Both data URLs (`data:image/<png|jpeg|gif|webp>;base64,...`) and remote URLs are accepted; remote URLs are downloaded by the AI SDK before being forwarded. Audio is not supported.

This feature relies on a runtime patch of `@augmentcode/auggie-sdk` because the upstream SDK does not yet expose its image wire format. The wire shape may change without notice on the Augment side.

## Structured logging

Per-request logs are emitted to stdout, one record per request, controlled
by two environment variables: `AOP_LOGGING` (verbosity) and `AOP_LOG_FORMAT` (shape).

**Levels** (`AOP_LOGGING`):

| Level | What is logged |
|---|---|
| `none` | Nothing — silent. |
| `info` *(default)* | `ts`, `method`, `path`, `status`, `durationMs`, `requestId`, `model`, `effectiveModel` (when the effort suffix swap rewrote the ID), `stream`, and `usage` (`input_tokens` / `output_tokens` / `total_tokens`). |
| `body` | Everything in `info` plus the parsed `request` body and the assembled `response` body. For streaming responses the assembled response is the concatenated text / thinking / tool-call arguments — not the raw SSE frames. |

**Formats** (`AOP_LOG_FORMAT`):

| Format | When to use |
|---|---|
| `text` *(default)* | Human-readable single line. Best for local development and tailing. `body` mode appends the request and response on indented continuation lines. |
| `json` | Single-line JSON per record. Best for `jq`, Loki, Vector, or any structured log collector. |

Example `info` line, `text` format:

```
[2026-05-04T12:34:56.789Z] INFO POST /v1/chat/completions 200 842ms model=claude-sonnet-4-5 req=chatcmpl-… tokens=42/128/170
```

Same record, `json` format:

```json
{"ts":"2026-05-04T12:34:56.789Z","level":"info","method":"POST","path":"/v1/chat/completions","status":200,"durationMs":842,"requestId":"chatcmpl-…","model":"claude-sonnet-4-5","stream":false,"usage":{"input_tokens":42,"output_tokens":128,"total_tokens":170}}
```

`body` mode also captures errors (`error` field) for failed generations.
