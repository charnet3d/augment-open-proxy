import { Hono } from "hono";
import { generateText, streamText } from "ai";
import type {
  ChatCompletionRequest,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ReasoningEffort,
  ReasoningSummary,
} from "../types/openai";
import { getAugmentModel } from "../services/augmentClient";
import {
  isModelAvailable,
  normalizeModelId,
  resolveEffortModelId,
} from "../services/modelRegistry";
import {
  transformMessages,
  transformTools,
  transformToolChoice,
  mapFinishReason,
  buildResponse,
  buildError,
} from "../utils/transformers";
import { attachLogData, flushLog } from "../services/logger";
import { randomUUID } from "node:crypto";

const router = new Hono();

// Request body size limit: 10MB
const MAX_BODY_SIZE = 10_000_000;
router.use("/completions", async (c, next) => {
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
  return `chatcmpl-${randomUUID()}`;
}

/**
 * Resolve the reasoning configuration from the request body. Accepts both
 * the top-level `reasoning_effort` (Chat Completions) and the nested
 * `reasoning: { effort, summary }` (Responses API). When both effort sources
 * are set, the nested form wins.
 */
function resolveReasoningConfig(
  body: ChatCompletionRequest
): { effort?: ReasoningEffort; summary?: ReasoningSummary } | undefined {
  const effort = body.reasoning?.effort ?? body.reasoning_effort;
  const summary = body.reasoning?.summary;
  if (!effort && !summary) return undefined;
  return {
    ...(effort && { effort }),
    ...(summary && { summary }),
  };
}

/**
 * Build providerOptions to plumb reasoning config through the AI SDK to the
 * Augment provider. The Augment SDK does not currently consume these keys,
 * but the namespace is forward-compatible: when the SDK adds support, the
 * proxy will already be passing the values.
 */
function buildProviderOptions(
  reasoning: ReturnType<typeof resolveReasoningConfig>
): { augment: Record<string, string> } | undefined {
  if (!reasoning) return undefined;
  const augment: Record<string, string> = {};
  if (reasoning.effort) augment.reasoningEffort = reasoning.effort;
  if (reasoning.summary) augment.reasoningSummary = reasoning.summary;
  return Object.keys(augment).length > 0 ? { augment } : undefined;
}

/**
 * Flatten reasoning output from a generateText result into a single string,
 * matching the DeepSeek/OpenRouter `reasoning_content` convention used by
 * the OpenAI-compatible client ecosystem (Open WebUI, aider, cline, …).
 * Prefers `reasoning` (array of provider parts), falling back to the
 * concatenated `reasoningText` string. Returns undefined when none.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildReasoningFromResult(result: any): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts = (result?.reasoning ?? []) as any[];
  const joined = parts
    .filter((p) => p?.type === "reasoning" && typeof p.text === "string" && p.text.length > 0)
    .map((p) => p.text as string)
    .join("");
  if (joined.length > 0) return joined;
  const text = typeof result?.reasoningText === "string" ? result.reasoningText : "";
  return text.length > 0 ? text : undefined;
}

// POST /completions
router.post("/completions", async (c) => {
  try {
    const body = (await c.req.json()) as ChatCompletionRequest;

    // Validate model
    const modelId = body.model;
    if (!modelId) {
      return c.json(buildError("Missing required field: model"), 400);
    }
    attachLogData(c, { model: modelId, stream: body.stream === true });

    // Strip Anthropic dated snapshot suffix (e.g. claude-haiku-4-5-20251001 →
    // claude-haiku-4-5) so dated IDs route to the canonical model the backend
    // recognises. `modelId` keeps the client's original value for the response
    // `model` field; `canonicalModelId` is what we use for backend lookups.
    const canonicalModelId = await normalizeModelId(modelId);

    // Allow any canonical model ID even if the registry is unavailable (e.g. no CLI).
    // Canonical names always start with a known provider prefix followed by a hyphen.
    const MODEL_PATTERN = /^(?:butler_a|(claude|gpt|gemini|code)-[a-z0-9][a-z0-9-]*)$/;
    const modelAvailable = await isModelAvailable(canonicalModelId);
    if (!modelAvailable && !MODEL_PATTERN.test(canonicalModelId)) {
      return c.json(
        buildError(
          `Model '${modelId}' is not available. Use GET /v1/models to see available models.`,
          "invalid_request_error",
          404
        ),
        404
      );
    }

    // The Augment SDK closes a turn into chat_history on every assistant
    // message and treats whatever accumulates after as the current question.
    // A trailing assistant message therefore serializes to an empty
    // `message`/`nodes` payload, which /chat-stream rejects as
    // `400 Bad Request - {"error":"Unidentified internal error"}`. Reject up
    // front with a useful message instead of forwarding the malformed call.
    const lastMsg = body.messages?.at(-1);
    if (lastMsg?.role === "assistant") {
      return c.json(
        buildError(
          "Conversation must end with a user or tool message; got trailing 'assistant' message. The Augment backend does not support assistant prefill (continuing an in-progress assistant turn).",
          "invalid_request_error",
          400
        ),
        400
      );
    }

    const requestId = generateId();
    const timestamp = Math.floor(Date.now() / 1000);
    attachLogData(c, { requestId });

    const reasoningConfig = resolveReasoningConfig(body);
    const providerOptions = buildProviderOptions(reasoningConfig);

    // Augment encodes reasoning depth in the model ID itself (e.g.
    // `claude-opus-4-7-high`). When the client asks for an effort level on a
    // base model that advertises one, swap to the suffixed variant so the
    // backend actually picks up the depth. Already-suffixed IDs and models
    // without advertised levels pass through unchanged.
    const effectiveModelId =
      (reasoningConfig?.effort
        ? await resolveEffortModelId(canonicalModelId, reasoningConfig.effort)
        : undefined) ?? canonicalModelId;
    if (effectiveModelId !== modelId) {
      attachLogData(c, { effectiveModel: effectiveModelId });
    }

    const modelInstance = await getAugmentModel(effectiveModelId);
    const messages = transformMessages(body.messages || []);
    const tools = transformTools(body.tools);
    const toolChoice = transformToolChoice(body.tool_choice);
    const stopSequences = Array.isArray(body.stop)
      ? body.stop
      : body.stop
        ? [body.stop]
        : undefined;

    const isStreaming = body.stream === true;

    if (isStreaming) {
      // --- STREAMING HANDLER ---
      // streamText is synchronous — no await. The stream is consumed lazily.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const streamResult = streamText({
        model: modelInstance as any,
        messages: messages as any,
        ...(tools && { tools: tools as any }),
        ...(toolChoice && { toolChoice: toolChoice as any }),
        ...(body.max_tokens && { maxTokens: body.max_tokens }),
        ...(body.temperature !== undefined && { temperature: body.temperature }),
        ...(body.top_p !== undefined && { topP: body.top_p }),
        ...(stopSequences && { stopSequences }),
        ...(providerOptions && { providerOptions }),
      });

      const textEncoder = new TextEncoder();
      const toolCallIndexMap = new Map<string, number>();
      let nextToolCallIndex = 0;

      const streamResponse = new ReadableStream({
        async start(controller) {
          // First chunk: establish the assistant role
          const roleChunk: ChatCompletionChunk = {
            id: requestId,
            object: "chat.completion.chunk",
            created: timestamp,
            model: modelId,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          };
          controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));

          let lastFinishReason: ChatCompletionChunk["choices"][0]["finish_reason"] = "stop";
          // Aggregated for the structured log only — never emitted to the client.
          let logText = "";
          let logReasoning = "";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const logToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let logUsage: any = undefined;
          let logStreamError: string | undefined;
          let sawFinish = false;

          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for await (const part of streamResult.fullStream as any) {
              if (part.type === "text-delta") {
                // AI SDK v5: field is `text` (not textDelta)
                const fragment: string = part.text ?? "";
                logText += fragment;
                const chunk: ChatCompletionChunk = {
                  id: requestId,
                  object: "chat.completion.chunk",
                  created: timestamp,
                  model: modelId,
                  choices: [{ index: 0, delta: { content: fragment }, finish_reason: null }],
                };
                controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

              } else if (part.type === "tool-input-start") {
                // AI SDK v5: tool-input-start (not tool-call-streaming-start), id field (not toolCallId)
                let toolIdx = toolCallIndexMap.get(part.id);
                if (toolIdx === undefined) {
                  toolIdx = nextToolCallIndex++;
                  toolCallIndexMap.set(part.id, toolIdx);
                }
                logToolCalls[toolIdx] = { id: part.id, name: part.toolName, arguments: "" };
                const chunk: ChatCompletionChunk = {
                  id: requestId,
                  object: "chat.completion.chunk",
                  created: timestamp,
                  model: modelId,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{ index: toolIdx, id: part.id, type: "function", function: { name: part.toolName, arguments: "" } }],
                    },
                    finish_reason: null,
                  }],
                };
                controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

              } else if (part.type === "tool-input-delta") {
                // AI SDK v5: tool-input-delta (not tool-call-delta), id field, delta field (not argsTextDelta)
                let toolIdx = toolCallIndexMap.get(part.id);
                if (toolIdx === undefined) {
                  toolIdx = nextToolCallIndex++;
                  toolCallIndexMap.set(part.id, toolIdx);
                }
                const tc = logToolCalls[toolIdx];
                if (tc) tc.arguments += part.delta ?? "";
                const chunk: ChatCompletionChunk = {
                  id: requestId,
                  object: "chat.completion.chunk",
                  created: timestamp,
                  model: modelId,
                  choices: [{
                    index: 0,
                    delta: { tool_calls: [{ index: toolIdx, function: { arguments: part.delta } }] },
                    finish_reason: null,
                  }],
                };
                controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

              } else if (part.type === "reasoning-delta") {
                // AI SDK v5 fullStream uses `text`; provider-level parts use `delta`.
                const fragment: string = part.text ?? part.delta ?? "";
                if (!fragment) continue;
                logReasoning += fragment;
                const chunk: ChatCompletionChunk = {
                  id: requestId,
                  object: "chat.completion.chunk",
                  created: timestamp,
                  model: modelId,
                  choices: [{ index: 0, delta: { reasoning_content: fragment }, finish_reason: null }],
                };
                controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

              } else if (part.type === "finish") {
                sawFinish = true;
                lastFinishReason = mapFinishReason(part.finishReason) as ChatCompletionChunk["choices"][0]["finish_reason"];
                logUsage = part.totalUsage ?? part.usage ?? undefined;
              } else if (part.type === "error") {
                // AI SDK v5 surfaces doStream rejections / mid-stream failures
                // as an `error` part on fullStream.
                const e = part.error;
                const msg = e instanceof Error ? e.message : (e?.message ?? String(e ?? "Stream error"));
                logStreamError = msg;
                controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({ error: { message: msg, type: "stream_error" } })}\n\n`));
              }
              // start / start-step / text-start / text-end / reasoning-start / reasoning-end / tool-input-available / finish-step → no SSE output
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Stream error";
            logStreamError = msg;
            controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({ error: { message: msg, type: "stream_error" } })}\n\n`));
          }

          // Upstream produced no output and no usage was reported. Mirrors the
          // guard in src/routes/messages.ts: the Augment backend has been seen
          // to close the SSE stream cleanly without emitting any events (or
          // with only a synthetic finish carrying zero tokens). Without this
          // guard the proxy would emit a clean `finish_reason: "stop"` with no
          // content, which OpenAI-compatible clients read as a deliberate
          // empty completion and never retry. A legitimate empty completion
          // still reports the prompt's input tokens, so `inputTokens === 0`
          // together with no text/reasoning/tool output is a reliable
          // upstream-failure signal.
          const upstreamInputTokens = logUsage?.promptTokens ?? logUsage?.inputTokens ?? 0;
          const upstreamOutputTokens = logUsage?.completionTokens ?? logUsage?.outputTokens ?? 0;
          const upstreamEmpty =
            logText === "" &&
            logReasoning === "" &&
            logToolCalls.length === 0 &&
            upstreamInputTokens === 0 &&
            upstreamOutputTokens === 0;
          if (upstreamEmpty && !logStreamError) {
            logStreamError = sawFinish
              ? "Upstream finished stream with no content and no usage"
              : "Upstream closed stream without producing any content";
            controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({ error: { message: logStreamError, type: "stream_error" } })}\n\n`));
          }

          // Final chunk with finish_reason, then [DONE]
          const finalChunk: ChatCompletionChunk = {
            id: requestId,
            object: "chat.completion.chunk",
            created: timestamp,
            model: modelId,
            choices: [{ index: 0, delta: {}, finish_reason: lastFinishReason }],
          };
          controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
          controller.enqueue(textEncoder.encode("data: [DONE]\n\n"));

          // Emit the structured log line now — the response status is 200 by
          // the time the stream is being consumed by the client.
          const inputTokens = logUsage?.promptTokens ?? logUsage?.inputTokens;
          const outputTokens = logUsage?.completionTokens ?? logUsage?.outputTokens;
          attachLogData(c, {
            usage: logUsage ? {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              total_tokens: logUsage.totalTokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0)),
            } : undefined,
            response: {
              id: requestId,
              finish_reason: lastFinishReason,
              content: logText || undefined,
              reasoning_content: logReasoning || undefined,
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

    // --- NON-STREAMING HANDLER ---
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await generateText({
        model: modelInstance as any,
        messages: messages as any,
        ...(tools && { tools: tools as any }),
        ...(toolChoice && { toolChoice: toolChoice as any }),
        ...(body.max_tokens && { maxTokens: body.max_tokens }),
        ...(body.temperature !== undefined && { temperature: body.temperature }),
        ...(body.top_p !== undefined && { topP: body.top_p }),
        ...(stopSequences && { stopSequences }),
        ...(providerOptions && { providerOptions }),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const aiToolCalls = (result.toolCalls ?? []) as any[];
      const toolCalls = aiToolCalls.map((tc) => ({
        id: tc.toolCallId,
        type: "function" as const,
        function: {
          name: tc.toolName,
          // AI SDK v5 uses `input` (object); older versions used `args`. Serialize to JSON string.
          arguments: (() => {
            const raw = tc.input ?? tc.args;
            return typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
          })(),
        },
      }));

      const reasoningContent = buildReasoningFromResult(result);

      const assistantMessage: ChatCompletionMessage = {
        role: "assistant",
        content: result.text || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        ...(reasoningContent && { reasoning_content: reasoningContent }),
      };

      const response = buildResponse(
        requestId,
        modelId,
        assistantMessage,
        mapFinishReason(result.finishReason)
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const usage = result.usage as any;
      response.usage = {
        prompt_tokens: usage.promptTokens ?? usage.inputTokens ?? 0,
        completion_tokens: usage.completionTokens ?? usage.outputTokens ?? 0,
        total_tokens: usage.totalTokens ?? ((usage.promptTokens ?? usage.inputTokens ?? 0) + (usage.completionTokens ?? usage.outputTokens ?? 0)),
      };

      attachLogData(c, {
        usage: {
          input_tokens: response.usage.prompt_tokens,
          output_tokens: response.usage.completion_tokens,
          total_tokens: response.usage.total_tokens,
        },
        response,
      });
      return c.json(response);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Generation failed";
      attachLogData(c, { error: errorMessage });
      return c.json(buildError(errorMessage, "server_error", 500), 500);
    }
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Internal server error";
    return c.json(buildError(errorMessage), 500);
  }
});

export default router;
