/**
 * Signature-error recovery for Augment router models (butler_a / prism-a).
 *
 * Vertex AI Gemini "thinking" variants require a `thought_signature` on every
 * replayed function_call in history. Augment strips signatures server-side, so
 * the proxy can't replay them. Always-flattening every tool turn confuses the
 * model (it sees its own past actions as plain-text breadcrumbs and confabulates
 * that downstream work is already done).
 *
 * Strategy: optimistic-first, retry-on-error.
 *   1. First attempt sends history fully structured (no flattening).
 *   2. If Augment rejects with a signature-related error, retry the same call
 *      with selective flattening — only assistant turns whose tool calls carry
 *      Gemini-routed IDs (`toolu_aug_vrtx_gemini_*`) are collapsed into plain
 *      text. Anthropic-routed calls stay structured so the model retains real
 *      tool I/O for everything that doesn't actually need a signature.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const GEMINI_TOOL_ID_PREFIX = "toolu_aug_vrtx_gemini_";
const FLATTEN_OPTION_KEY = "__sigFlatten";

function isGeminiToolId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(GEMINI_TOOL_ID_PREFIX);
}

/**
 * Detect Augment errors caused by missing thought_signature on a replayed
 * function_call. The SDK surfaces them as `Augment API error: <status>
 * <statusText> - <body>`; Vertex Gemini phrases them around
 * `function_call`/`function_response` ordering when a call lacks its signature.
 */
function isSignatureError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /thought[_ ]signature|function[_ ]call|function[_ ]response|signature/i.test(msg);
}

function toolResultToText(part: any): string {
  const output = part?.output;
  if (!output) return "";
  if (output.type === "text" || output.type === "error-text") return String(output.value ?? "");
  if (output.type === "json" || output.type === "error-json") {
    try { return JSON.stringify(output.value); } catch { return ""; }
  }
  if (output.type === "content" && Array.isArray(output.value)) {
    return output.value
      .filter((p: any) => p?.type === "text")
      .map((p: any) => String(p.text ?? ""))
      .join("");
  }
  return "";
}

/**
 * Identify which assistant turns contain any Gemini-routed tool call and
 * return the set of tool_call_ids that should be flattened. A whole turn is
 * marked once any of its calls is Gemini — Gemini requires every call in the
 * same turn to carry a signature, so we can't split structured + flattened
 * within one turn.
 */
function collectGeminiTurnIds(messages: any[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const hasGemini = msg.content.some(
      (p: any) => p.type === "tool-call" && isGeminiToolId(p.toolCallId),
    );
    if (!hasGemini) continue;
    for (const p of msg.content) {
      if (p.type === "tool-call" && typeof p.toolCallId === "string") {
        ids.add(p.toolCallId);
      }
    }
  }
  return ids;
}

function rewriteAssistantTurn(msg: any, flattenedIds: Set<string>): any {
  const toolCalls = msg.content.filter((p: any) => p.type === "tool-call");
  const needsFlatten = toolCalls.some((p: any) => flattenedIds.has(p.toolCallId));
  if (!needsFlatten) return msg;
  const text = msg.content
    .map((part: any) => {
      if (part.type === "text") return part.text;
      if (part.type === "tool-call") {
        const input = typeof part.input === "string" ? part.input : JSON.stringify(part.input);
        return `[Assistant called tool: ${part.toolName} with input: ${input}]`;
      }
      if (part.type === "reasoning") return `[Thought: ${part.text}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return { ...msg, content: [{ type: "text", text: text || "(omitted)" }] };
}

function rewriteToolMessage(msg: any, flattenedIds: Set<string>, out: any[]): void {
  const flatParts = msg.content.filter(
    (p: any) => p?.type === "tool-result" && flattenedIds.has(p.toolCallId),
  );
  const liveParts = msg.content.filter(
    (p: any) => !(p?.type === "tool-result" && flattenedIds.has(p.toolCallId)),
  );
  if (flatParts.length > 0) {
    const resultText = flatParts
      .map((p: any) => `[Tool result for ${p.toolName ?? "tool"}: ${toolResultToText(p)}]`)
      .join("\n");
    // Re-roled as user to keep the conversation rhythm intact: the SDK pairs
    // user→assistant into chat_history turns and uses the final user message
    // as the current outbound `message`/`nodes` source.
    out.push({ role: "user", content: [{ type: "text", text: resultText }] });
  }
  if (liveParts.length > 0) out.push({ ...msg, content: liveParts });
}

/**
 * Flatten only assistant turns whose tool calls were routed via Gemini.
 * Non-Gemini turns remain structured so the model still sees real tool I/O
 * for everything that doesn't actually need a thought_signature.
 */
function flattenGeminiTurns(messages: any[]): any[] {
  if (!Array.isArray(messages)) return messages;
  const flattenedIds = collectGeminiTurnIds(messages);
  if (flattenedIds.size === 0) return messages;
  const out: any[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      out.push(rewriteAssistantTurn(msg, flattenedIds));
    } else if (msg.role === "tool" && Array.isArray(msg.content)) {
      rewriteToolMessage(msg, flattenedIds, out);
    } else {
      out.push(msg);
    }
  }
  return out;
}

function stripFlattenMarker(options: any): any {
  if (!options || typeof options !== "object" || !(FLATTEN_OPTION_KEY in options)) {
    return options;
  }
  const { [FLATTEN_OPTION_KEY]: _omit, ...rest } = options;
  return rest;
}

/**
 * Wrap the streamed first attempt so that a signature error surfaced either
 * as a thrown rejection or an inline `{type:"error"}` chunk triggers a
 * transparent retry against `origDoStream` with the flatten marker set. Only
 * fires when the error appears on (or before) the very first emitted chunk —
 * once any real content has been forwarded to the caller, retry is unsafe.
 */
function wrapStreamWithRetry(
  first: any,
  options: any,
  origDoStream: (opts: any) => Promise<any>,
): any {
  const wrappedStream = new ReadableStream({
    async start(controller) {
      const reader = first.stream.getReader();
      let seenChunk = false;
      const pumpRetry = async (): Promise<void> => {
        const retry = await origDoStream({ ...options, [FLATTEN_OPTION_KEY]: true });
        const retryReader = retry.stream.getReader();
        try {
          while (true) {
            const { done, value } = await retryReader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } finally {
          retryReader.releaseLock();
        }
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // SDK enqueues `{type:"error", error}` then calls controller.error;
          // catch it on the first chunk so we can retry transparently.
          if (!seenChunk && value && typeof value === "object" && value.type === "error") {
            if (isSignatureError(value.error)) {
              console.log("[sig] doStream signature error in first chunk; retrying with Gemini flatten");
              reader.releaseLock();
              await pumpRetry();
              return;
            }
          }
          seenChunk = true;
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        if (!seenChunk && isSignatureError(err)) {
          console.log("[sig] doStream signature error before first chunk; retrying with Gemini flatten");
          reader.releaseLock();
          try {
            await pumpRetry();
          } catch (retryErr) {
            controller.error(retryErr);
          }
          return;
        }
        controller.error(err);
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    },
  });
  return { ...first, stream: wrappedStream };
}

/**
 * Wraps `model.buildPayload`, `model.doGenerate`, and `model.doStream` to
 * implement try-structured / retry-with-Gemini-flatten on signature errors.
 * Gated to known router model IDs (butler_a / prism-a); composes with the
 * image patch by extending whatever methods are already bound on the model.
 */
export function patchModelForSignatures(model: any): void {
  if (!model) return;
  if (model.modelId !== "butler_a" && model.modelId !== "prism-a") return;
  if (typeof model.buildPayload !== "function") return;

  const origBuildPayload = model.buildPayload.bind(model);
  model.buildPayload = (options: any) => {
    const stripped = stripFlattenMarker(options);
    if (options?.[FLATTEN_OPTION_KEY] && Array.isArray(options.prompt)) {
      return origBuildPayload({ ...stripped, prompt: flattenGeminiTurns(options.prompt) });
    }
    return origBuildPayload(stripped);
  };

  if (typeof model.doGenerate === "function") {
    const origDoGenerate = model.doGenerate.bind(model);
    model.doGenerate = async (options: any) => {
      try {
        return await origDoGenerate(options);
      } catch (err) {
        if (!isSignatureError(err)) throw err;
        console.log("[sig] doGenerate signature error; retrying with Gemini flatten");
        return await origDoGenerate({ ...options, [FLATTEN_OPTION_KEY]: true });
      }
    };
  }

  if (typeof model.doStream === "function") {
    const origDoStream = model.doStream.bind(model);
    model.doStream = async (options: any) => {
      const first = await origDoStream(options);
      if (typeof first?.stream?.getReader !== "function") return first;
      return wrapStreamWithRetry(first, options, origDoStream);
    };
  }
}
