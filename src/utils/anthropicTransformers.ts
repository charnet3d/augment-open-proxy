import { jsonSchema } from "ai";
import type {
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicSystem,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicStopReason,
  AnthropicThinkingConfig,
} from "../types/anthropic";
import type { ReasoningEffort } from "../types/openai";
import type { CoreMessage, CoreTool, CoreToolChoice } from "./transformers";
import { safeJsonParse } from "./transformers";

// ── Inline AI SDK part types (kept in sync with transformers.ts) ──────────
type AiTextPart = { type: "text"; text: string };
type AiImagePart = {
  type: "image";
  image: string | URL | Uint8Array | ArrayBuffer | Buffer;
  mediaType?: string;
};
type AiToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
};
type AiToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "text"; value: string } | { type: "json"; value: unknown };
};

/**
 * Flatten an Anthropic `system` field (string or array of text blocks) into
 * a single string. The AI SDK system role only accepts string content.
 */
export function flattenSystem(system: AnthropicSystem | undefined): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Coerce an Anthropic image source into AI SDK ImagePart shape.
 */
function transformImageSource(
  source: Extract<AnthropicContentBlock, { type: "image" }>["source"]
): AiImagePart {
  if (source.type === "base64") {
    return { type: "image", image: source.data, mediaType: source.media_type };
  }
  try {
    return { type: "image", image: new URL(source.url) };
  } catch {
    return { type: "image", image: source.url };
  }
}

/**
 * Stringify a tool_result content payload (string or array of text/image
 * blocks) into a plain text value. Image parts inside tool results are
 * dropped — the AI SDK tool-result `output.text` channel is text-only.
 */
function toolResultToText(
  content: Extract<AnthropicContentBlock, { type: "tool_result" }>["content"]
): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Convert Anthropic Messages (plus optional system prompt) into AI SDK
 * CoreMessage[]. Anthropic puts tool_result blocks inside user-role messages,
 * so a single user message may need to be split into a tool-role message
 * (for the tool_result blocks) followed by a user-role message (for any
 * text/image blocks). The AI SDK expects them as separate messages.
 */
export function transformAnthropicMessages(
  messages: AnthropicMessage[],
  system?: AnthropicSystem
): CoreMessage[] {
  const out: CoreMessage[] = [];
  const sys = flattenSystem(system);
  if (sys) out.push({ role: "system", content: sys });

  for (const msg of messages) {
    const blocks: AnthropicContentBlock[] =
      typeof msg.content === "string"
        ? [{ type: "text", text: msg.content }]
        : msg.content;

    if (msg.role === "system") {
      // Mid-conversation system messages (e.g. Claude Code's skills-list
      // injection) must NOT be misclassified as assistant — that turns them
      // into a synthetic assistant turn that flushes pending nodes into
      // chat_history and leaves the outbound current `message` empty.
      const text = blocks
        .filter((b): b is AnthropicTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text) out.push({ role: "system", content: text });
    } else if (msg.role === "user") {
      const toolResults: AiToolResultPart[] = [];
      const userParts: Array<AiTextPart | AiImagePart> = [];
      for (const b of blocks) {
        if (b.type === "tool_result") {
          toolResults.push({
            type: "tool-result",
            toolCallId: b.tool_use_id,
            toolName: "unknown",
            output: { type: "text", value: toolResultToText(b.content) },
          });
        } else if (b.type === "text") {
          userParts.push({ type: "text", text: b.text });
        } else if (b.type === "image") {
          userParts.push(transformImageSource(b.source));
        }
      }
      if (toolResults.length > 0) {
        out.push({ role: "tool", content: toolResults });
      }
      if (userParts.length > 0) {
        out.push({ role: "user", content: userParts });
      } else if (toolResults.length === 0) {
        out.push({ role: "user", content: "" });
      }
    } else {
      // assistant
      const parts: Array<AiTextPart | AiToolCallPart> = [];
      for (const b of blocks) {
        if (b.type === "text") {
          parts.push({ type: "text", text: b.text });
        } else if (b.type === "tool_use") {
          parts.push({
            type: "tool-call",
            toolCallId: b.id,
            toolName: b.name,
            input:
              typeof b.input === "string" ? safeJsonParse(b.input) : b.input,
          });
        }
        // thinking blocks are dropped on the way in (model produces fresh ones)
      }
      const onlyText =
        parts.length === 1 && parts[0].type === "text" ? parts[0].text : null;
      out.push({
        role: "assistant",
        content: onlyText !== null ? onlyText : parts,
      });
    }
  }

  // Resolve tool-result toolName by walking back to the assistant tool-call.
  const idToName = new Map<string, string>();
  for (const m of out) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "tool-call") idToName.set(p.toolCallId, p.toolName);
      }
    }
  }
  for (const m of out) {
    if (m.role === "tool") {
      for (const p of m.content) {
        const resolved = idToName.get(p.toolCallId);
        if (resolved) p.toolName = resolved;
      }
    }
  }

  return out;
}

/**
 * Convert Anthropic tools into AI SDK tool definitions.
 */
export function transformAnthropicTools(
  tools?: AnthropicTool[]
): Record<string, CoreTool> | undefined {
  if (!tools?.length) return undefined;
  const result: Record<string, CoreTool> = {};
  for (const t of tools) {
    if (typeof t?.name !== "string" || !t.input_schema) continue;
    result[t.name] = {
      description: t.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: jsonSchema(t.input_schema as any),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Map Anthropic tool_choice to AI SDK CoreToolChoice.
 *   { type: "auto" }        → "auto"
 *   { type: "any" }         → "required"
 *   { type: "tool", name }  → { type: "tool", toolName: name }
 *   { type: "none" }        → "none"
 */
export function transformAnthropicToolChoice(
  choice?: AnthropicToolChoice
): CoreToolChoice | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "tool", toolName: choice.name };
    default:
      return undefined;
  }
}

/**
 * Map AI SDK finishReason → Anthropic stop_reason.
 */
export function mapStopReason(
  reason: string | undefined
): AnthropicStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool-calls":
    case "tool_calls":
      return "tool_use";
    case "content-filter":
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

/**
 * Map an Anthropic `thinking` config to an OpenAI-style ReasoningEffort,
 * which the chat-flow logic then turns into an Augment effort suffix on the
 * model ID. Budget thresholds mirror the OpenAI minimal/low/medium/high tiers
 * roughly: ≤ 4096 → low, ≤ 16384 → medium, > 16384 → high.
 */
export function thinkingToEffort(
  thinking: AnthropicThinkingConfig | undefined
): ReasoningEffort | undefined {
  if (thinking?.type !== "enabled") return undefined;
  const budget = thinking.budget_tokens;
  if (typeof budget !== "number" || budget <= 0) return "low";
  if (budget <= 4096) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}

/**
 * Estimate token count for an Anthropic Messages request when the upstream
 * does not expose an exact counter. Uses a 4-chars-per-token heuristic over
 * all stringifiable text in the system prompt and message content.
 */
export function estimateTokenCount(
  messages: AnthropicMessage[],
  system?: AnthropicSystem
): number {
  let chars = flattenSystem(system).length;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else {
      for (const b of m.content) {
        if (b.type === "text") chars += b.text.length;
        else if (b.type === "tool_use") chars += JSON.stringify(b.input ?? {}).length + b.name.length;
        else if (b.type === "tool_result") chars += toolResultToText(b.content).length;
        else if (b.type === "thinking") chars += b.thinking.length;
      }
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}
