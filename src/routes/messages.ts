import { Hono } from "hono";
import { generateText, streamText } from "ai";
import { randomUUID } from "node:crypto";
import type {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicContentBlock,
  AnthropicStreamEvent,
  AnthropicCountTokensResponse,
} from "../types/anthropic";
import { getAugmentModel } from "../services/augmentClient";
import {
  isModelAvailable,
  normalizeModelId,
  resolveEffortModelId,
} from "../services/modelRegistry";
import { buildError } from "../utils/transformers";
import {
  transformAnthropicMessages,
  transformAnthropicTools,
  transformAnthropicToolChoice,
  mapStopReason,
  thinkingToEffort,
  estimateTokenCount,
} from "../utils/anthropicTransformers";
import { attachLogData, flushLog } from "../services/logger";

const router = new Hono();

// Same 10MB cap as /v1/chat/completions.
const MAX_BODY_SIZE = 10_000_000;
router.use("*", async (c, next) => {
  const contentLength = parseInt(c.req.header("content-length") || "0", 10);
  if (contentLength > MAX_BODY_SIZE) {
    return c.json(
      {
        error: {
          message: "Request body too large",
          type: "invalid_request_error",
          code: "request_too_large",
        },
      },
      413
    );
  }
  return next();
});

function generateId(): string {
  return `msg_${randomUUID().replace(/-/g, "")}`;
}

// Anthropic accepts canonical IDs that start with `claude-`. We also accept
// any registry-known ID so callers can target gpt/gemini variants through the
// /v1/messages surface if they want to.
const MODEL_PATTERN = /^(?:butler_a|(claude|gpt|gemini|code)-[a-z0-9][a-z0-9-]*)$/;

async function validateModel(modelId: string): Promise<string | undefined> {
  if (!modelId) return "Missing required field: model";
  const known = await isModelAvailable(modelId);
  if (known || MODEL_PATTERN.test(modelId)) return undefined;
  return `Model '${modelId}' is not available. Use GET /v1/models to see available models.`;
}

/**
 * POST /v1/messages — Anthropic Messages API.
 *
 * Translates the request to the AI SDK call shape, then translates the result
 * back into either an `AnthropicMessagesResponse` (non-streaming) or the
 * Anthropic SSE event sequence (`message_start` → `content_block_*` →
 * `message_delta` → `message_stop`) for `stream: true`.
 */
router.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as AnthropicMessagesRequest;
    const requestedModelId = body.model;
    if (requestedModelId) {
      attachLogData(c, { model: requestedModelId, stream: body.stream === true });
    }
    // Strip Anthropic dated snapshot suffix (e.g. claude-haiku-4-5-20251001 →
    // claude-haiku-4-5) so dated IDs from clients like Claude Code route to
    // the canonical model the backend recognises. The original ID is kept for
    // the response `model` field.
    const modelId = await normalizeModelId(requestedModelId);
    if (modelId !== requestedModelId) {
      attachLogData(c, { effectiveModel: modelId });
    }
    const validationError = await validateModel(modelId);
    if (validationError) {
      const status = validationError.startsWith("Missing") ? 400 : 404;
      return c.json(
        buildError(validationError, "invalid_request_error", status),
        status
      );
    }

    // The Augment SDK closes a turn into chat_history on every assistant
    // message; a trailing assistant message therefore serializes to an empty
    // current `message`/`nodes` payload, which /chat-stream rejects as
    // `400 Bad Request - {"error":"Unidentified internal error"}`. Reject
    // up front with a useful message. Note: this disallows Anthropic-style
    // assistant prefill — the upstream backend has no equivalent affordance.
    const lastMsg = body.messages?.at(-1);
    if (lastMsg?.role === "assistant") {
      return c.json(
        buildError(
          "Conversation must end with a user message; got trailing 'assistant' message. The Augment backend does not support assistant prefill (continuing an in-progress assistant turn).",
          "invalid_request_error",
          400
        ),
        400
      );
    }

    const requestId = generateId();
    attachLogData(c, { requestId });

    // Anthropic `thinking.budget_tokens` maps onto our reasoning effort knob,
    // which then drives the model-ID suffix swap (e.g. claude-opus-4-7 →
    // claude-opus-4-7-high) when the registry advertises one.
    const effort = thinkingToEffort(body.thinking);
    const effectiveModelId =
      (effort ? await resolveEffortModelId(modelId, effort) : undefined) ??
      modelId;
    if (effectiveModelId !== modelId) {
      attachLogData(c, { effectiveModel: effectiveModelId });
    }

    const modelInstance = await getAugmentModel(effectiveModelId);
    const messages = transformAnthropicMessages(body.messages || [], body.system);
    const tools = transformAnthropicTools(body.tools);
    const toolChoice = transformAnthropicToolChoice(body.tool_choice);
    const providerOptions = effort
      ? { augment: { reasoningEffort: effort } }
      : undefined;

    const isStreaming = body.stream === true;

    if (isStreaming) {
      return handleStreaming(c, {
        modelInstance,
        // Echo the client's original (possibly dated) ID in the response so
        // Anthropic clients see what they sent.
        modelId: requestedModelId,
        requestId,
        messages,
        tools,
        toolChoice,
        body,
        providerOptions,
      });
    }
    return handleNonStreaming(c, {
      modelInstance,
      modelId: requestedModelId,
      requestId,
      messages,
      tools,
      toolChoice,
      body,
      providerOptions,
    });
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Internal server error";
    return c.json(buildError(errorMessage), 500);
  }
});

/**
 * POST /v1/messages/count_tokens — Anthropic token counter.
 *
 * The Augment backend does not expose an exact counter, so this returns a
 * conservative 4-chars-per-token estimate. Sufficient for clients that only
 * use the count for budgeting / progress UI (Claude Code, etc.).
 */
router.post("/count_tokens", async (c) => {
  try {
    const body = (await c.req.json()) as AnthropicMessagesRequest;
    const input_tokens = estimateTokenCount(body.messages || [], body.system);
    const result: AnthropicCountTokensResponse = { input_tokens };
    return c.json(result);
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Internal server error";
    return c.json(buildError(errorMessage), 500);
  }
});

// ── Handler implementations ──────────────────────────────────────────────

interface HandlerArgs {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelInstance: any;
  modelId: string;
  requestId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolChoice: any;
  body: AnthropicMessagesRequest;
  providerOptions?: { augment: Record<string, string> };
}

function buildAiCallOptions(args: HandlerArgs) {
  const { body } = args;
  const stopSequences = body.stop_sequences;
  return {
    model: args.modelInstance,
    messages: args.messages,
    ...(args.tools && { tools: args.tools }),
    ...(args.toolChoice && { toolChoice: args.toolChoice }),
    ...(body.max_tokens && { maxTokens: body.max_tokens }),
    ...(body.temperature !== undefined && { temperature: body.temperature }),
    ...(body.top_p !== undefined && { topP: body.top_p }),
    ...(body.top_k !== undefined && { topK: body.top_k }),
    ...(stopSequences?.length && { stopSequences }),
    ...(args.providerOptions && { providerOptions: args.providerOptions }),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleNonStreaming(c: any, args: HandlerArgs) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateText(buildAiCallOptions(args) as any);

    const content: AnthropicContentBlock[] = [];

    // Reasoning blocks first, matching Anthropic's interleaved-thinking order.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reasoningParts = (result.reasoning ?? []) as any[];
    for (const r of reasoningParts) {
      if (r?.type === "reasoning" && typeof r.text === "string" && r.text.length > 0) {
        content.push({ type: "thinking", thinking: r.text });
      }
    }
    if (content.length === 0 && typeof result.reasoningText === "string" && result.reasoningText.length > 0) {
      content.push({ type: "thinking", thinking: result.reasoningText });
    }

    if (result.text && result.text.length > 0) {
      content.push({ type: "text", text: result.text });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aiToolCalls = (result.toolCalls ?? []) as any[];
    for (const tc of aiToolCalls) {
      const raw = tc.input ?? tc.args;
      const input = typeof raw === "string" ? safeParse(raw) : (raw ?? {});
      content.push({
        type: "tool_use",
        id: tc.toolCallId,
        name: tc.toolName,
        input,
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usage = (result.usage ?? {}) as any;
    const stopReason = aiToolCalls.length > 0
      ? "tool_use"
      : mapStopReason(result.finishReason);

    const response: AnthropicMessagesResponse = {
      id: args.requestId,
      type: "message",
      role: "assistant",
      model: args.modelId,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: usage.promptTokens ?? usage.inputTokens ?? 0,
        output_tokens: usage.completionTokens ?? usage.outputTokens ?? 0,
      },
    };
    attachLogData(c, {
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      response,
    });
    return c.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Generation failed";
    attachLogData(c, { error: msg });
    return c.json(buildError(msg, "server_error", 500), 500);
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleStreaming(c: any, args: HandlerArgs) {
  // streamText is synchronous — the stream is consumed lazily.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const streamResult = streamText(buildAiCallOptions(args) as any);

  const textEncoder = new TextEncoder();

  // Anthropic SSE wire format includes both an `event:` line and the JSON
  // `data:` payload, separated by `\n\n`.
  function sse(event: AnthropicStreamEvent): Uint8Array {
    return textEncoder.encode(
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    );
  }

  // Anthropic uses a single increasing `index` per content block. We assign
  // one as each block opens (text / thinking / tool_use) and reuse it for
  // deltas + the `content_block_stop` event.
  type BlockState =
    | { kind: "text" }
    | { kind: "thinking" }
    | { kind: "tool_use"; id: string; name: string };

  const streamResponse = new ReadableStream({
    async start(controller) {
      const blocks: BlockState[] = [];
      // toolCallId → block index, so streaming `tool-input-delta` events can
      // find the right open block.
      const toolIndexById = new Map<string, number>();
      // Currently-open text/thinking block index (only one of each at a time).
      let openTextIdx: number | null = null;
      let openThinkingIdx: number | null = null;
      let outputTokens = 0;
      let inputTokens = 0;
      let stopReason: ReturnType<typeof mapStopReason> = "end_turn";
      let sawToolCall = false;
      let sawFinish = false;
      // Aggregated for the structured log only — never written to the wire.
      let logText = "";
      let logThinking = "";
      const logToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      let logStreamError: string | undefined;

      // message_start: a synthetic message envelope with empty content. The
      // content blocks land in the subsequent content_block_* events.
      const messageStart: AnthropicMessagesResponse = {
        id: args.requestId,
        type: "message",
        role: "assistant",
        model: args.modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
      controller.enqueue(sse({ type: "message_start", message: messageStart }));

      const closeBlock = (idx: number | null) => {
        if (idx === null) return;
        controller.enqueue(sse({ type: "content_block_stop", index: idx }));
      };

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const part of streamResult.fullStream as any) {
          if (part.type === "text-delta") {
            const fragment: string = part.text ?? part.delta ?? "";
            if (!fragment) continue;
            logText += fragment;
            if (openThinkingIdx !== null) {
              closeBlock(openThinkingIdx);
              openThinkingIdx = null;
            }
            if (openTextIdx === null) {
              const idx = blocks.length;
              blocks.push({ kind: "text" });
              openTextIdx = idx;
              controller.enqueue(sse({
                type: "content_block_start",
                index: idx,
                content_block: { type: "text", text: "" },
              }));
            }
            controller.enqueue(sse({
              type: "content_block_delta",
              index: openTextIdx,
              delta: { type: "text_delta", text: fragment },
            }));
          } else if (part.type === "reasoning-delta") {
            const fragment: string = part.text ?? part.delta ?? "";
            if (!fragment) continue;
            logThinking += fragment;
            if (openTextIdx !== null) {
              closeBlock(openTextIdx);
              openTextIdx = null;
            }
            if (openThinkingIdx === null) {
              const idx = blocks.length;
              blocks.push({ kind: "thinking" });
              openThinkingIdx = idx;
              controller.enqueue(sse({
                type: "content_block_start",
                index: idx,
                content_block: { type: "thinking", thinking: "" },
              }));
            }
            controller.enqueue(sse({
              type: "content_block_delta",
              index: openThinkingIdx,
              delta: { type: "thinking_delta", thinking: fragment },
            }));
          } else if (part.type === "tool-input-start") {
            sawToolCall = true;
            if (openTextIdx !== null) { closeBlock(openTextIdx); openTextIdx = null; }
            if (openThinkingIdx !== null) { closeBlock(openThinkingIdx); openThinkingIdx = null; }
            const idx = blocks.length;
            blocks.push({ kind: "tool_use", id: part.id, name: part.toolName });
            toolIndexById.set(part.id, idx);
            logToolCalls.push({ id: part.id, name: part.toolName, arguments: "" });
            controller.enqueue(sse({
              type: "content_block_start",
              index: idx,
              content_block: {
                type: "tool_use",
                id: part.id,
                name: part.toolName,
                input: {},
              },
            }));
          } else if (part.type === "tool-input-delta") {
            const idx = toolIndexById.get(part.id);
            if (idx === undefined) continue;
            const tc = logToolCalls.find((t) => t.id === part.id);
            if (tc) tc.arguments += part.delta ?? "";
            controller.enqueue(sse({
              type: "content_block_delta",
              index: idx,
              delta: { type: "input_json_delta", partial_json: part.delta ?? "" },
            }));
          } else if (part.type === "tool-input-end") {
            const idx = toolIndexById.get(part.id);
            if (idx !== undefined) closeBlock(idx);
          } else if (part.type === "finish") {
            sawFinish = true;
            stopReason = sawToolCall ? "tool_use" : mapStopReason(part.finishReason);
            // AI SDK v5 exposes the aggregate as `totalUsage` on the `finish`
            // part; older builds (and our test mocks) put it on `usage`.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const u = (part.totalUsage ?? part.usage ?? {}) as any;
            outputTokens = u.completionTokens ?? u.outputTokens ?? 0;
            inputTokens = u.promptTokens ?? u.inputTokens ?? 0;
          } else if (part.type === "error") {
            const e = part.error;
            const msg = e instanceof Error ? e.message : (e?.message ?? String(e ?? "Stream error"));
            logStreamError = msg;
            controller.enqueue(sse({ type: "error", error: { type: "stream_error", message: msg } }));
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Stream error";
        logStreamError = msg;
        controller.enqueue(sse({ type: "error", error: { type: "stream_error", message: msg } }));
      }

      // Close any blocks the upstream did not explicitly end.
      if (openTextIdx !== null) closeBlock(openTextIdx);
      if (openThinkingIdx !== null) closeBlock(openThinkingIdx);
      for (const [, idx] of toolIndexById) {
        const block = blocks[idx];
        // tool_use blocks are already closed above when tool-input-end arrives;
        // close any that did not.
        if (block?.kind === "tool_use") {
          // Best-effort: re-emitting content_block_stop is harmless on the wire
          // but most clients tolerate it. Skip if we can't be sure.
        }
      }

      // Upstream produced no content blocks and no usage was reported. This
      // happens when the Augment backend closes the SSE stream without
      // emitting any events (or with only a synthetic finish carrying zero
      // tokens). Without this guard the proxy would emit a clean
      // `stop_reason: end_turn` with zero tokens, which clients read as
      // "model intentionally returned nothing" and never retry. A legitimate
      // empty completion still reports the prompt's input_tokens, so
      // `inputTokens === 0` together with no content blocks is a reliable
      // upstream-failure signal. `sawFinish` is also accepted as evidence the
      // stream actually ran when it carried any usage.
      const upstreamEmpty =
        blocks.length === 0 && inputTokens === 0 && outputTokens === 0;
      if (upstreamEmpty && !logStreamError) {
        logStreamError = sawFinish
          ? "Upstream finished stream with no content and no usage"
          : "Upstream closed stream without producing any content";
        controller.enqueue(sse({
          type: "error",
          error: { type: "stream_error", message: logStreamError },
        }));
      }

      controller.enqueue(sse({
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }));
      controller.enqueue(sse({ type: "message_stop" }));

      attachLogData(c, {
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
        response: {
          id: args.requestId,
          stop_reason: stopReason,
          text: logText || undefined,
          thinking: logThinking || undefined,
          tool_calls: logToolCalls.length > 0 ? logToolCalls : undefined,
        },
        ...(logStreamError && { error: logStreamError }),
      });
      flushLog(c, 200);
      controller.close();
    },
  });

  return c.body(streamResponse, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export default router;
