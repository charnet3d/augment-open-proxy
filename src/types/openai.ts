// OpenAI-compatible request/response types

/**
 * Reasoning effort knob (matches OpenAI Responses / Chat Completions API).
 * Per the OpenAI reasoning guide, supported values are model-dependent and
 * can include `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Reasoning summary mode (Responses API parameter).
 */
export type ReasoningSummary = "auto" | "concise" | "detailed";

/**
 * Text part of an OpenAI multimodal `content` array.
 */
export interface ChatCompletionContentPartText {
  type: "text";
  text: string;
}

/**
 * Image part of an OpenAI multimodal `content` array. The `url` may be a
 * regular http(s) URL or an inline `data:<mime>;base64,<data>` URL.
 */
export interface ChatCompletionContentPartImage {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export type ChatCompletionContentPart =
  | ChatCompletionContentPartText
  | ChatCompletionContentPartImage;

export interface ChatCompletionMessage {
  // `developer` is OpenAI's o-series rename of `system` (and is accepted as a
  // synonym for system on non-reasoning models). Treated identically to system.
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | ChatCompletionContentPart[] | null;
  tool_calls?: ChatCompletionToolCall[];
  tool_call_id?: string;
  name?: string;
  /**
   * Reasoning text surfaced by reasoning-capable models. Plain string,
   * matching the de-facto convention used by DeepSeek, OpenRouter, and the
   * OpenAI-compatible client ecosystem (Open WebUI, aider, cline, litellm).
   */
  reasoning_content?: string;
}

export interface ChatCompletionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type ChatCompletionToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ChatCompletionFunctionTool[];
  tool_choice?: ChatCompletionToolChoice;
  stop?: string | string[];
  /**
   * Top-level reasoning effort, accepted by the OpenAI Chat Completions API
   * for reasoning-capable models (o-series, gpt-5*).
   */
  reasoning_effort?: ReasoningEffort;
  /**
   * Responses-API-style reasoning configuration. Either field is optional.
   * When both `reasoning_effort` and `reasoning.effort` are set, the nested
   * value wins.
   */
  reasoning?: {
    effort?: ReasoningEffort;
    summary?: ReasoningSummary;
  };
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "error" | null;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
  system_fingerprint?: string;
}

export interface ChatCompletionChunkDelta {
  role?: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ChatCompletionToolCallChunk[];
  /**
   * Incremental reasoning text fragment for reasoning-capable models. Plain
   * string, matching the DeepSeek/OpenRouter convention consumed by Open
   * WebUI and other OpenAI-compatible clients.
   */
  reasoning_content?: string;
}

export interface ChatCompletionToolCallChunk {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  system_fingerprint?: string;
  /**
   * Token usage. Only emitted on the terminal chunk of a stream (alongside
   * an empty `choices` array, per the OpenAI streaming-usage convention) so
   * OpenAI-compatible clients (Opencode, OpenWebUI, …) can populate their
   * token counters. Augment does not guarantee exact counts.
   */
  usage?: ChatCompletionUsage;
}

export interface ModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface ModelsListResponse {
  object: "list";
  data: ModelObject[];
}

export interface ErrorResponse {
  error: {
    message: string;
    type: string;
    param?: string | null;
    code?: string | number;
  };
}
