import { Hono } from "hono";
import { generateText, streamText } from "ai";
import { randomUUID } from "node:crypto";
import { TextEncoder } from "node:util";
import type {
  ReasoningEffort,
  ReasoningSummary,
} from "../types/openai";
import type {
  ResponseRequest,
  ResponseObject,
  ResponseOutputItem,
  ResponseStreamEvent,
  ResponseUsage,
} from "../types/responses";
import { getAugmentModel } from "../services/augmentClient";
import {
  isModelAvailable,
  normalizeModelId,
  resolveEffortModelId,
} from "../services/modelRegistry";
import {
  transformResponseInput,
  transformResponseTools,
  transformResponseToolChoice,
} from "../utils/responsesTransformers";
import { buildError } from "../utils/transformers";
import { attachLogData, flushLog } from "../services/logger";

const router = new Hono();

// Same 10MB cap as the other routes.
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

// Canonical model IDs start with a known provider prefix followed by a hyphen.
// The sole router model is matched exactly under its user-facing name
// (prism-a, internally translated to butler_a); no other router variants are
// accepted until a second router is confirmed. prism-custom is a non-router
// alias (internally translated to prism_tenant_custom).
const MODEL_PATTERN =
  /^(?:prism-a|butler_a|prism-custom|prism_tenant_custom|(claude|gpt|gemini|code)-[a-z0-9][a-z0-9-]*)$/;

function generateResponseId(): string {
  return `resp_${randomUUID().replace(/-/g, "")}`;
}
function generateMsgId(): string {
  return `msg_${randomUUID().replace(/-/g, "")}`;
}
function generateReasoningId(): string {
  return `rs_${randomUUID().replace(/-/g, "")}`;
}
function generateCallId(): string {
  return `fc_${randomUUID().replace(/-/g, "")}`;
}

/**
 * Resolve reasoning config from a Responses-API request body.
 * Mirrors the chat-completions helper but only supports the nested
 * `reasoning: { effort, summary }` form (Responses API has no top-level
 * `reasoning_effort`).
 */
function resolveReasoningConfig(
  body: ResponseRequest
): { effort?: ReasoningEffort; summary?: ReasoningSummary } | undefined {
  const effort = body.reasoning?.effort;
  const summary = body.reasoning?.summary;
  if (!effort && !summary) return undefined;
  return {
    ...(effort && { effort }),
    ...(summary && { summary }),
  };
}

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
 * The Augment SDK closes a turn on every assistant message and treats
 * everything after as the current question. A trailing assistant message
 * (or a trailing function_call) therefore serializes to an empty current
 * payload, which /chat-stream rejects upstream. Mirror the same guard as
 * /v1/chat/completions and /v1/messages by detecting it up front.
 *
 * `function_call_output` and user/system/developer messages are valid
 * trailing items.
 */
function isTrailingAssistant(input: ResponseRequest["input"]): boolean {
  if (typeof input !== "object" || input == null || !Array.isArray(input)) {
    return false;
  }
  // Walk backwards skipping reasoning items (they don't count as a turn).
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item.type === "reasoning") continue;
    if (item.type === "function_call") return true;
    if ((item.type === undefined || item.type === "message") &&
        (item as { role?: string }).role === "assistant") {
      return true;
    }
    return false;
  }
  return false;
}

interface BuildResponseObjectArgs {
  id: string;
  model: string;
  status: ResponseObject["status"];
  output: ResponseOutputItem[];
  usage?: ResponseUsage;
  body: ResponseRequest;
  reasoningConfig: ReturnType<typeof resolveReasoningConfig>;
  error?: { code: string; message: string } | null;
}

function buildResponseObject(args: BuildResponseObjectArgs): ResponseObject {
  const { body, reasoningConfig } = args;
  return {
    id: args.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: args.status,
    error: args.error ?? null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    model: args.model,
    output: args.output,
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    previous_response_id: body.previous_response_id ?? null,
    reasoning: {
      effort: reasoningConfig?.effort ?? null,
      summary: reasoningConfig?.summary ?? null,
    },
    store: body.store ?? false,
    temperature: body.temperature ?? null,
    text: body.text?.format ? { format: body.text.format } : { format: { type: "text" } },
    tool_choice: body.tool_choice ?? "auto",
    tools: body.tools ?? [],
    top_p: body.top_p ?? null,
    truncation: body.truncation ?? "disabled",
    ...(args.usage && { usage: args.usage }),
    user: body.user ?? null,
    metadata: body.metadata ?? {},
  };
}

/**
 * POST /v1/responses — OpenAI Responses API.
 *
 * Translates the request to the AI SDK `generateText`/`streamText` shape,
 * then translates the result back into either a `ResponseObject` (non-
 * streaming) or the Responses-API SSE event sequence (`response.created`
 * → `response.output_item.added` → content/argument deltas →
 * `response.output_item.done` → `response.completed`).
 */
/**
 * Validate the request body. Returns an error message + status when the
 * request is malformed; returns undefined when validation passes. Extracted
 * so the route handler stays under the cognitive-complexity threshold.
 */
async function validateRequest(
  body: ResponseRequest
): Promise<{ message: string; status: 400 | 404 } | undefined> {
  if (!body.model) {
    return { message: "Missing required field: model", status: 400 };
  }
  if (body.input == null) {
    return { message: "Missing required field: input", status: 400 };
  }
  const canonical = await normalizeModelId(body.model);
  const known = await isModelAvailable(canonical);
  if (!known && !MODEL_PATTERN.test(canonical)) {
    return {
      message: `Model '${body.model}' is not available. Use GET /v1/models to see available models.`,
      status: 404,
    };
  }
  if (isTrailingAssistant(body.input)) {
    return {
      message:
        "Conversation must end with a user, system, or function_call_output item; got trailing assistant message or function_call. The Augment backend does not support assistant prefill.",
      status: 400,
    };
  }
  return undefined;
}

router.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as ResponseRequest;

    attachLogData(c, {
      model: body.model,
      stream: body.stream === true,
    });

    const validationError = await validateRequest(body);
    if (validationError) {
      return c.json(
        buildError(
          validationError.message,
          "invalid_request_error",
          validationError.status
        ),
        validationError.status
      );
    }

    const requestedModelId = body.model;
    const canonicalModelId = await normalizeModelId(requestedModelId);

    const requestId = generateResponseId();
    attachLogData(c, { requestId });

    const reasoningConfig = resolveReasoningConfig(body);
    const providerOptions = buildProviderOptions(reasoningConfig);

    // Augment encodes reasoning depth in the model ID itself (e.g.
    // `claude-opus-4-7-high`). Swap to the suffixed variant when the
    // registry advertises one for the requested effort.
    const effectiveModelId =
      (reasoningConfig?.effort
        ? await resolveEffortModelId(canonicalModelId, reasoningConfig.effort)
        : undefined) ?? canonicalModelId;
    if (effectiveModelId !== requestedModelId) {
      attachLogData(c, { effectiveModel: effectiveModelId });
    }

    const modelInstance = await getAugmentModel(effectiveModelId);
    const messages = transformResponseInput(body.input, body.instructions);
    const tools = transformResponseTools(body.tools);
    const toolChoice = transformResponseToolChoice(body.tool_choice);

    const aiOptions = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: modelInstance as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(tools && { tools: tools as any }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(toolChoice && { toolChoice: toolChoice as any }),
      ...(body.max_output_tokens && { maxTokens: body.max_output_tokens }),
      ...(body.temperature !== undefined && { temperature: body.temperature }),
      ...(body.top_p !== undefined && { topP: body.top_p }),
      ...(providerOptions && { providerOptions }),
    };

    const isStreaming = body.stream === true;
    if (isStreaming) {
      return handleStreaming(c, {
        aiOptions,
        body,
        requestedModelId,
        requestId,
        reasoningConfig,
      });
    }
    return await handleNonStreaming(c, {
      aiOptions,
      body,
      requestedModelId,
      requestId,
      reasoningConfig,
    });
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Internal server error";
    return c.json(buildError(errorMessage), 500);
  }
});

interface HandlerArgs {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aiOptions: any;
  body: ResponseRequest;
  requestedModelId: string;
  requestId: string;
  reasoningConfig: ReturnType<typeof resolveReasoningConfig>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildUsage(usage: any): ResponseUsage {
  const input_tokens = usage?.promptTokens ?? usage?.inputTokens ?? 0;
  const output_tokens = usage?.completionTokens ?? usage?.outputTokens ?? 0;
  const total_tokens =
    usage?.totalTokens ?? input_tokens + output_tokens;
  return { input_tokens, output_tokens, total_tokens };
}

/**
 * Build the `output` array for a Responses-API result. The order matches
 * the chat-completions pattern: any reasoning summary first, then the
 * assistant message (when text is present), then function_call items.
 */
function buildOutputItems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any
): { items: ResponseOutputItem[]; sawToolCall: boolean } {
  const items: ResponseOutputItem[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reasoningParts = (result.reasoning ?? []) as any[];
  const reasoningTextJoined = reasoningParts
    .filter((p) => p?.type === "reasoning" && typeof p.text === "string" && p.text.length > 0)
    .map((p) => p.text as string)
    .join("");
  let reasoningText = reasoningTextJoined;
  if (reasoningText.length === 0 && typeof result.reasoningText === "string") {
    reasoningText = result.reasoningText;
  }
  if (reasoningText.length > 0) {
    items.push({
      type: "reasoning",
      id: generateReasoningId(),
      summary: [{ type: "summary_text", text: reasoningText }],
      status: "completed",
    });
  }

  if (typeof result.text === "string" && result.text.length > 0) {
    items.push({
      type: "message",
      id: generateMsgId(),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: result.text, annotations: [] }],
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aiToolCalls = (result.toolCalls ?? []) as any[];
  for (const tc of aiToolCalls) {
    const raw = tc.input ?? tc.args;
    const argsString = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
    items.push({
      type: "function_call",
      id: generateCallId(),
      call_id: tc.toolCallId,
      name: tc.toolName,
      arguments: argsString,
      status: "completed",
    });
  }
  return { items, sawToolCall: aiToolCalls.length > 0 };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleNonStreaming(c: any, args: HandlerArgs) {
  try {
    const result = await generateText(args.aiOptions);
    const { items } = buildOutputItems(result);
    const usage = buildUsage(result.usage);
    const response = buildResponseObject({
      id: args.requestId,
      model: args.requestedModelId,
      status: "completed",
      output: items,
      usage,
      body: args.body,
      reasoningConfig: args.reasoningConfig,
    });
    attachLogData(c, {
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
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

// ── Streaming handler ─────────────────────────────────────────────────────
// Tracks per-output-item state across the AI SDK fullStream so we can emit
// the Responses-API SSE event sequence (response.output_item.added →
// content/argument deltas → response.output_item.done → response.completed).
type OpenItem =
  | { kind: "message"; outputIndex: number; itemId: string; text: string }
  | { kind: "reasoning"; outputIndex: number; itemId: string; text: string }
  | { kind: "function_call"; outputIndex: number; itemId: string; callId: string; name: string; args: string };

interface StreamCtx {
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  seq: { n: number };
  outputs: ResponseOutputItem[];
}

function sseEvent(
  ctx: StreamCtx,
  event: ResponseStreamEvent
): void {
  // Mutate the placeholder sequence_number to the live counter so test code
  // and downstream consumers see a strictly monotonic sequence.
  (event as { sequence_number: number }).sequence_number = ctx.seq.n++;
  ctx.controller.enqueue(
    ctx.encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  );
}

function closeMessageItem(ctx: StreamCtx, item: Extract<OpenItem, { kind: "message" }>): void {
  sseEvent(ctx, {
    type: "response.output_text.done",
    item_id: item.itemId,
    output_index: item.outputIndex,
    content_index: 0,
    text: item.text,
    sequence_number: 0,
  });
  sseEvent(ctx, {
    type: "response.content_part.done",
    item_id: item.itemId,
    output_index: item.outputIndex,
    content_index: 0,
    part: { type: "output_text", text: item.text, annotations: [] },
    sequence_number: 0,
  });
  const finalItem: ResponseOutputItem = {
    type: "message",
    id: item.itemId,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: item.text, annotations: [] }],
  };
  ctx.outputs[item.outputIndex] = finalItem;
  sseEvent(ctx, {
    type: "response.output_item.done",
    output_index: item.outputIndex,
    item: finalItem,
    sequence_number: 0,
  });
}

function closeReasoningItem(ctx: StreamCtx, item: Extract<OpenItem, { kind: "reasoning" }>): void {
  sseEvent(ctx, {
    type: "response.reasoning_summary_text.done",
    item_id: item.itemId,
    output_index: item.outputIndex,
    summary_index: 0,
    text: item.text,
    sequence_number: 0,
  });
  sseEvent(ctx, {
    type: "response.reasoning_summary_part.done",
    item_id: item.itemId,
    output_index: item.outputIndex,
    summary_index: 0,
    part: { type: "summary_text", text: item.text },
    sequence_number: 0,
  });
  const finalItem: ResponseOutputItem = {
    type: "reasoning",
    id: item.itemId,
    summary: [{ type: "summary_text", text: item.text }],
    status: "completed",
  };
  ctx.outputs[item.outputIndex] = finalItem;
  sseEvent(ctx, {
    type: "response.output_item.done",
    output_index: item.outputIndex,
    item: finalItem,
    sequence_number: 0,
  });
}

function closeFunctionCallItem(
  ctx: StreamCtx,
  item: Extract<OpenItem, { kind: "function_call" }>
): void {
  sseEvent(ctx, {
    type: "response.function_call_arguments.done",
    item_id: item.itemId,
    output_index: item.outputIndex,
    arguments: item.args,
    sequence_number: 0,
  });
  const finalItem: ResponseOutputItem = {
    type: "function_call",
    id: item.itemId,
    call_id: item.callId,
    name: item.name,
    arguments: item.args,
    status: "completed",
  };
  ctx.outputs[item.outputIndex] = finalItem;
  sseEvent(ctx, {
    type: "response.output_item.done",
    output_index: item.outputIndex,
    item: finalItem,
    sequence_number: 0,
  });
}

function closeOpenItem(ctx: StreamCtx, item: OpenItem): void {
  if (item.kind === "message") closeMessageItem(ctx, item);
  else if (item.kind === "reasoning") closeReasoningItem(ctx, item);
  else closeFunctionCallItem(ctx, item);
}

function openMessageItem(
  ctx: StreamCtx,
  outputIndex: number
): Extract<OpenItem, { kind: "message" }> {
  const itemId = generateMsgId();
  const placeholder: ResponseOutputItem = {
    type: "message",
    id: itemId,
    status: "in_progress",
    role: "assistant",
    content: [],
  };
  ctx.outputs[outputIndex] = placeholder;
  sseEvent(ctx, {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: placeholder,
    sequence_number: 0,
  });
  sseEvent(ctx, {
    type: "response.content_part.added",
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
    sequence_number: 0,
  });
  return { kind: "message", outputIndex, itemId, text: "" };
}

function openReasoningItem(
  ctx: StreamCtx,
  outputIndex: number
): Extract<OpenItem, { kind: "reasoning" }> {
  const itemId = generateReasoningId();
  const placeholder: ResponseOutputItem = {
    type: "reasoning",
    id: itemId,
    summary: [],
    status: "in_progress",
  };
  ctx.outputs[outputIndex] = placeholder;
  sseEvent(ctx, {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: placeholder,
    sequence_number: 0,
  });
  sseEvent(ctx, {
    type: "response.reasoning_summary_part.added",
    item_id: itemId,
    output_index: outputIndex,
    summary_index: 0,
    part: { type: "summary_text", text: "" },
    sequence_number: 0,
  });
  return { kind: "reasoning", outputIndex, itemId, text: "" };
}

function openFunctionCallItem(
  ctx: StreamCtx,
  outputIndex: number,
  callId: string,
  name: string
): Extract<OpenItem, { kind: "function_call" }> {
  const itemId = generateCallId();
  const placeholder: ResponseOutputItem = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name,
    arguments: "",
    status: "in_progress",
  };
  ctx.outputs[outputIndex] = placeholder;
  sseEvent(ctx, {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: placeholder,
    sequence_number: 0,
  });
  return { kind: "function_call", outputIndex, itemId, callId, name, args: "" };
}

interface StreamState {
  // Per-item registries.
  textItem: Extract<OpenItem, { kind: "message" }> | null;
  reasoningItem: Extract<OpenItem, { kind: "reasoning" }> | null;
  toolItems: Map<string, Extract<OpenItem, { kind: "function_call" }>>;
  nextOutputIndex: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  usage: any;
  sawFinish: boolean;
  streamError: string | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleTextDelta(ctx: StreamCtx, state: StreamState, part: any): void {
  const fragment: string = part.text ?? part.delta ?? "";
  if (!fragment) return;
  // Reasoning deltas can no longer interleave once a text run starts; close
  // the open reasoning block if any.
  if (state.reasoningItem) {
    closeReasoningItem(ctx, state.reasoningItem);
    state.reasoningItem = null;
  }
  if (!state.textItem) {
    state.textItem = openMessageItem(ctx, state.nextOutputIndex++);
  }
  state.textItem.text += fragment;
  sseEvent(ctx, {
    type: "response.output_text.delta",
    item_id: state.textItem.itemId,
    output_index: state.textItem.outputIndex,
    content_index: 0,
    delta: fragment,
    sequence_number: 0,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleReasoningDelta(ctx: StreamCtx, state: StreamState, part: any): void {
  const fragment: string = part.text ?? part.delta ?? "";
  if (!fragment) return;
  if (state.textItem) {
    closeMessageItem(ctx, state.textItem);
    state.textItem = null;
  }
  if (!state.reasoningItem) {
    state.reasoningItem = openReasoningItem(ctx, state.nextOutputIndex++);
  }
  state.reasoningItem.text += fragment;
  sseEvent(ctx, {
    type: "response.reasoning_summary_text.delta",
    item_id: state.reasoningItem.itemId,
    output_index: state.reasoningItem.outputIndex,
    summary_index: 0,
    delta: fragment,
    sequence_number: 0,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleToolInputStart(ctx: StreamCtx, state: StreamState, part: any): void {
  if (state.textItem) {
    closeMessageItem(ctx, state.textItem);
    state.textItem = null;
  }
  if (state.reasoningItem) {
    closeReasoningItem(ctx, state.reasoningItem);
    state.reasoningItem = null;
  }
  const item = openFunctionCallItem(
    ctx,
    state.nextOutputIndex++,
    part.id,
    part.toolName
  );
  state.toolItems.set(part.id, item);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleToolInputDelta(ctx: StreamCtx, state: StreamState, part: any): void {
  const item = state.toolItems.get(part.id);
  if (!item) return;
  const delta: string = part.delta ?? "";
  if (!delta) return;
  item.args += delta;
  sseEvent(ctx, {
    type: "response.function_call_arguments.delta",
    item_id: item.itemId,
    output_index: item.outputIndex,
    delta,
    sequence_number: 0,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dispatchStreamPart(ctx: StreamCtx, state: StreamState, part: any): void {
  switch (part.type) {
    case "text-delta":
      handleTextDelta(ctx, state, part);
      return;
    case "reasoning-delta":
      handleReasoningDelta(ctx, state, part);
      return;
    case "tool-input-start":
      handleToolInputStart(ctx, state, part);
      return;
    case "tool-input-delta":
      handleToolInputDelta(ctx, state, part);
      return;
    case "finish":
      state.sawFinish = true;
      state.usage = part.totalUsage ?? part.usage ?? undefined;
      return;
    case "error": {
      const e = part.error;
      const msg =
        e instanceof Error ? e.message : (e?.message ?? String(e ?? "Stream error"));
      state.streamError = msg;
      sseEvent(ctx, {
        type: "error",
        message: msg,
        code: null,
        param: null,
        sequence_number: 0,
      });
      return;
    }
    default:
      return; // start, start-step, text-start, etc. → no SSE output
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function finalizeStream(ctx: StreamCtx, state: StreamState, c: any, args: HandlerArgs): void {
  const usage = buildUsage(state.usage);
  // Mirror the chat-completions empty-stream guard: the Augment backend has
  // been seen to close the SSE stream cleanly without yielding any events
  // (or with only a synthetic finish carrying zero tokens). Without this
  // guard the proxy would emit a clean response.completed with no output,
  // which clients read as a deliberate empty completion. A legitimate empty
  // completion still reports the prompt's input tokens.
  const upstreamEmpty =
    ctx.outputs.length === 0 &&
    usage.input_tokens === 0 &&
    usage.output_tokens === 0;
  if (upstreamEmpty && !state.streamError) {
    state.streamError = state.sawFinish
      ? "Upstream finished stream with no content and no usage"
      : "Upstream closed stream without producing any content";
    sseEvent(ctx, {
      type: "error",
      message: state.streamError,
      code: null,
      param: null,
      sequence_number: 0,
    });
  }

  const finalStatus: ResponseObject["status"] = state.streamError ? "failed" : "completed";
  const finalResponse = buildResponseObject({
    id: args.requestId,
    model: args.requestedModelId,
    status: finalStatus,
    output: ctx.outputs,
    usage,
    body: args.body,
    reasoningConfig: args.reasoningConfig,
    error: state.streamError
      ? { code: "stream_error", message: state.streamError }
      : null,
  });
  sseEvent(ctx, {
    type: state.streamError ? "response.failed" : "response.completed",
    response: finalResponse,
    sequence_number: 0,
  });

  attachLogData(c, {
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
    },
    response: finalResponse,
    ...(state.streamError && { error: state.streamError }),
  });
  flushLog(c, 200);
}

function closeAllOpenItems(ctx: StreamCtx, state: StreamState): void {
  if (state.textItem) {
    closeMessageItem(ctx, state.textItem);
    state.textItem = null;
  }
  if (state.reasoningItem) {
    closeReasoningItem(ctx, state.reasoningItem);
    state.reasoningItem = null;
  }
  for (const item of state.toolItems.values()) {
    closeFunctionCallItem(ctx, item);
  }
  state.toolItems.clear();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleStreaming(c: any, args: HandlerArgs) {
  // streamText is synchronous — the stream is consumed lazily.
  const streamResult = streamText(args.aiOptions);
  const encoder = new TextEncoder();

  const streamResponse = new ReadableStream<Uint8Array>({
    async start(controller) {
      const ctx: StreamCtx = { controller, encoder, seq: { n: 0 }, outputs: [] };
      const state: StreamState = {
        textItem: null,
        reasoningItem: null,
        toolItems: new Map(),
        nextOutputIndex: 0,
        usage: undefined,
        sawFinish: false,
        streamError: undefined,
      };

      // Emit the initial response.created event with an in-progress envelope.
      const initial = buildResponseObject({
        id: args.requestId,
        model: args.requestedModelId,
        status: "in_progress",
        output: [],
        body: args.body,
        reasoningConfig: args.reasoningConfig,
      });
      sseEvent(ctx, { type: "response.created", response: initial, sequence_number: 0 });
      sseEvent(ctx, { type: "response.in_progress", response: initial, sequence_number: 0 });

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const part of streamResult.fullStream as any) {
          dispatchStreamPart(ctx, state, part);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Stream error";
        state.streamError = msg;
        sseEvent(ctx, {
          type: "error",
          message: msg,
          code: null,
          param: null,
          sequence_number: 0,
        });
      }

      closeAllOpenItems(ctx, state);
      finalizeStream(ctx, state, c, args);
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
