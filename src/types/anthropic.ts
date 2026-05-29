// Anthropic Messages API request/response types.
// Mirrors the public shape documented at
// https://docs.anthropic.com/en/api/messages — only the fields the proxy
// actually consumes/produces are modelled here.

// ── Content blocks ────────────────────────────────────────────────────────
export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" } | null;
}

export interface AnthropicImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?:
    | string
    | Array<AnthropicTextBlock | AnthropicImageBlock>;
  is_error?: boolean;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock;

// ── Messages ──────────────────────────────────────────────────────────────
export interface AnthropicMessage {
  // Anthropic's public spec only documents user/assistant, but Claude Code
  // and similar clients sometimes inject a mid-conversation system message
  // (e.g. an updated skills list). Accept it here and let the transformer
  // route it to the AI SDK system role.
  role: "user" | "assistant" | "system";
  content: string | AnthropicContentBlock[];
}

export type AnthropicSystem = string | AnthropicTextBlock[];

// ── Tools ─────────────────────────────────────────────────────────────────
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
  | { type: "none" };

// ── Thinking config ───────────────────────────────────────────────────────
export type AnthropicThinkingConfig =
  | { type: "enabled"; budget_tokens: number }
  | { type: "disabled" };

// ── Request ───────────────────────────────────────────────────────────────
export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: AnthropicSystem;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  thinking?: AnthropicThinkingConfig;
  metadata?: Record<string, unknown>;
}

// ── Response ──────────────────────────────────────────────────────────────
export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal";

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// ── Streaming events ──────────────────────────────────────────────────────
export type AnthropicStreamEvent =
  | { type: "message_start"; message: AnthropicMessagesResponse }
  | {
      type: "content_block_start";
      index: number;
      content_block: AnthropicContentBlock;
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "signature_delta"; signature: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: AnthropicStopReason | null; stop_sequence: string | null };
      usage: { output_tokens: number };
    }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

// ── Token counting ────────────────────────────────────────────────────────
export interface AnthropicCountTokensResponse {
  input_tokens: number;
}
