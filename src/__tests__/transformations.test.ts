/**
 * Tests for the transformation helpers in src/utils/transformers.ts.
 *
 * These test the pure transformation logic directly without HTTP overhead.
 */
import { describe, it, expect } from "vitest";
import {
  transformMessages,
  transformTools,
  transformToolChoice,
  mapFinishReason,
  safeJsonParse,
} from "../utils/transformers";
import {
  flattenSystem,
  transformAnthropicMessages,
  transformAnthropicTools,
  transformAnthropicToolChoice,
  mapStopReason,
  thinkingToEffort,
  estimateTokenCount,
} from "../utils/anthropicTransformers";
import type { ChatCompletionMessage } from "../types/openai";
import type {
  AnthropicMessage,
  AnthropicSystem,
  AnthropicTool,
  AnthropicToolChoice,
} from "../types/anthropic";

// ── Tests ─────────────────────────────────────────────────────

describe("safeJsonParse", () => {
  it("should parse valid JSON", () => {
    expect(safeJsonParse('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("should return original string on parse failure", () => {
    expect(safeJsonParse("not valid json")).toBe("not valid json");
  });

  it("should parse numbers", () => {
    expect(safeJsonParse("42")).toBe(42);
  });

  it("should parse arrays", () => {
    expect(safeJsonParse('[1, 2, 3]')).toEqual([1, 2, 3]);
  });
});

describe("transformMessages", () => {
  it("should transform user message with text content", () => {
    const result = transformMessages([
      { role: "user", content: "Hello" },
    ]);

    expect(result).toEqual([
      { role: "user", content: "Hello" },
    ]);
  });

  it("should transform user message with null content", () => {
    const result = transformMessages([
      { role: "user", content: null },
    ]);

    expect(result).toEqual([{ role: "user", content: "" }]);
  });

  it("should transform system message as plain string content", () => {
    const result = transformMessages([
      { role: "system", content: "You are helpful." },
    ]);

    expect(result).toEqual([
      { role: "system", content: "You are helpful." },
    ]);
  });

  it("should transform system message with null content to empty string", () => {
    const result = transformMessages([
      { role: "system", content: null },
    ]);

    expect(result).toEqual([{ role: "system", content: "" }]);
  });

  it("should transform developer message as system (o-series rename)", () => {
    const result = transformMessages([
      { role: "developer", content: "You are helpful." },
    ]);

    expect(result).toEqual([
      { role: "system", content: "You are helpful." },
    ]);
  });

  it("should flatten developer message with array text parts to a string", () => {
    const result = transformMessages([
      {
        role: "developer",
        content: [
          { type: "text", text: "You are " },
          { type: "text", text: "helpful." },
        ],
      } as ChatCompletionMessage,
    ]);

    expect(result).toEqual([{ role: "system", content: "You are helpful." }]);
  });

  it("should transform assistant message with text content", () => {
    const result = transformMessages([
      { role: "assistant", content: "I can help with that." },
    ]);

    expect(result).toEqual([
      {
        role: "assistant",
        content: "I can help with that.",
      },
    ]);
  });

  it("should transform assistant message with tool calls", () => {
    const result = transformMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "getWeather",
              arguments: '{"city":"NYC"}',
            },
          },
        ],
      },
    ]);

    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_123",
            toolName: "getWeather",
            input: { city: "NYC" },
          },
        ],
      },
    ]);
  });

  it("should handle malformed JSON in tool call arguments gracefully", () => {
    const result = transformMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "getWeather",
              arguments: "not valid json",
            },
          },
        ],
      },
    ]);

    expect((result[0].content as any[])[0].input).toBe("not valid json");
  });

  it("should transform assistant message with both text and tool calls", () => {
    const result = transformMessages([
      {
        role: "assistant",
        content: "Let me check the weather.",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "getWeather",
              arguments: '{"city":"NYC"}',
            },
          },
        ],
      },
    ]);

    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check the weather." },
          {
            type: "tool-call",
            toolCallId: "call_123",
            toolName: "getWeather",
            input: { city: "NYC" },
          },
        ],
      },
    ]);
  });

  it("should transform tool result message with tool-result part", () => {
    const result = transformMessages([
      {
        role: "tool",
        content: '{"temp": 72}',
        tool_call_id: "call_123",
        name: "getWeather",
      },
    ]);

    expect(result).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_123",
            toolName: "getWeather",
            output: { type: "text", value: '{"temp": 72}' },
          },
        ],
      },
    ]);
  });

  it("should handle tool message with missing tool_call_id", () => {
    const result = transformMessages([
      {
        role: "tool",
        content: "result",
        name: "someTool",
      },
    ]);

    expect(result).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "",
            toolName: "someTool",
            output: { type: "text", value: "result" },
          },
        ],
      },
    ]);
  });

  it("should transform user message with multimodal text + image_url (data URL)", () => {
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const result = transformMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ]);

    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          {
            type: "image",
            image:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
            mediaType: "image/png",
          },
        ],
      },
    ]);
  });

  it("should transform user message with image_url (remote http URL)", () => {
    const result = transformMessages([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
        ],
      },
    ]);

    const content = (result[0] as any).content as any[];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("image");
    expect(content[0].image).toBeInstanceOf(URL);
    expect((content[0].image as URL).href).toBe("https://example.com/cat.jpg");
    expect(content[0].mediaType).toBeUndefined();
  });

  it("should flatten system message with array text parts to a string", () => {
    const result = transformMessages([
      {
        role: "system",
        content: [
          { type: "text", text: "You are " },
          { type: "text", text: "helpful." },
        ],
      } as ChatCompletionMessage,
    ]);

    expect(result).toEqual([{ role: "system", content: "You are helpful." }]);
  });

  it("should flatten assistant message with array text parts to a string", () => {
    const result = transformMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      } as ChatCompletionMessage,
    ]);

    expect(result).toEqual([{ role: "assistant", content: "ok" }]);
  });

  it("should handle a full conversation with multiple message types", () => {
    const result = transformMessages([
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "What's the weather in NYC?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "getWeather", arguments: '{"city":"NYC"}' },
          },
        ],
      },
      {
        role: "tool",
        content: '{"temp": 72, "unit": "F"}',
        tool_call_id: "call_1",
        name: "getWeather",
      },
      { role: "assistant", content: "It's 72°F in NYC." },
    ]);

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ role: "system", content: "You are an assistant." });
    expect(result[1]).toEqual({ role: "user", content: "What's the weather in NYC?" });
    expect((result[2] as any).content[0].type).toBe("tool-call");
    expect((result[3] as any).role).toBe("tool");
    expect((result[3] as any).content[0].type).toBe("tool-result");
    expect((result[4] as any).content).toBe("It's 72°F in NYC.");
  });
});

describe("transformTools", () => {
  it("should return undefined for empty tools array", () => {
    expect(transformTools([])).toBeUndefined();
  });

  it("should return undefined for undefined tools", () => {
    expect(transformTools(undefined)).toBeUndefined();
  });

  it("should transform a single function tool into a Record by name", () => {
    const result = transformTools([
      {
        type: "function",
        function: {
          name: "getWeather",
          description: "Get the weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      },
    ]) as Record<string, any>;

    expect(result).toBeDefined();
    expect(result["getWeather"]).toBeDefined();
    expect(result["getWeather"].description).toBe("Get the weather");
    // inputSchema is wrapped by jsonSchema() — check the inner JSON schema
    expect(result["getWeather"].inputSchema.jsonSchema).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
    });
  });

  it("should handle tool without description", () => {
    const result = transformTools([
      {
        type: "function",
        function: {
          name: "simple",
          parameters: {},
        },
      },
    ]) as Record<string, any>;

    expect(result).toBeDefined();
    expect(result["simple"]).toBeDefined();
    expect(result["simple"].description).toBeUndefined();
    expect(result["simple"].inputSchema.jsonSchema).toEqual({});
  });

  it("should handle multiple tools", () => {
    const result = transformTools([
      {
        type: "function",
        function: { name: "tool1", parameters: {} },
      },
      {
        type: "function",
        function: { name: "tool2", parameters: {} },
      },
    ]) as Record<string, any>;

    expect(result).toBeDefined();
    expect(result["tool1"]).toBeDefined();
    expect(result["tool2"]).toBeDefined();
    expect(Object.keys(result)).toHaveLength(2);
  });
});

describe("transformToolChoice", () => {
  it("should return undefined for undefined input", () => {
    expect(transformToolChoice(undefined)).toBeUndefined();
  });

  it("should pass through 'none' as a string", () => {
    expect(transformToolChoice("none")).toBe("none");
  });

  it("should pass through 'auto' as a string", () => {
    expect(transformToolChoice("auto")).toBe("auto");
  });

  it("should pass through 'required' as a string", () => {
    expect(transformToolChoice("required")).toBe("required");
  });

  it("should transform object tool_choice with function name", () => {
    expect(transformToolChoice({ type: "function", function: { name: "getWeather" } })).toEqual({
      type: "tool",
      toolName: "getWeather",
    });
  });
});

describe("mapFinishReason", () => {
  it("should pass through 'stop'", () => {
    expect(mapFinishReason("stop")).toBe("stop");
  });

  it("should pass through 'length'", () => {
    expect(mapFinishReason("length")).toBe("length");
  });

  it("should pass through 'tool_calls'", () => {
    expect(mapFinishReason("tool_calls")).toBe("tool_calls");
  });

  it("should pass through 'content_filter'", () => {
    expect(mapFinishReason("content_filter")).toBe("content_filter");
  });

  it("should map 'tool-calls' to 'tool_calls'", () => {
    expect(mapFinishReason("tool-calls")).toBe("tool_calls");
  });

  it("should map 'content-filter' to 'content_filter'", () => {
    expect(mapFinishReason("content-filter")).toBe("content_filter");
  });

  it("should default 'error' to 'stop'", () => {
    expect(mapFinishReason("error")).toBe("stop");
  });

  it("should default undefined to 'stop'", () => {
    expect(mapFinishReason(undefined)).toBe("stop");
  });

  it("should default unknown values to 'stop'", () => {
    expect(mapFinishReason("unknown-reason")).toBe("stop");
  });
});


// ── Responses-API transformers (src/utils/responsesTransformers.ts) ─────
import {
  transformResponseInput,
  transformResponseTools,
  transformResponseToolChoice,
} from "../utils/responsesTransformers";
import type {
  ResponseInputItem,
  ResponseTool,
  ResponseToolChoice,
} from "../types/responses";

describe("transformResponseInput", () => {
  it("returns an empty array when input is null and no instructions", () => {
    expect(transformResponseInput(undefined)).toEqual([]);
  });

  it("prepends instructions as a system message", () => {
    const result = transformResponseInput("hi", "You are concise.");
    expect(result[0]).toEqual({ role: "system", content: "You are concise." });
    expect(result[1]).toEqual({ role: "user", content: "hi" });
  });

  it("ignores empty instructions", () => {
    const result = transformResponseInput("hi", "");
    expect(result).toEqual([{ role: "user", content: "hi" }]);
  });

  it("wraps a string input as a single user message", () => {
    expect(transformResponseInput("hello")).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("maps a system-role message with parts to a flat string system message", () => {
    const input: ResponseInputItem[] = [
      {
        type: "message",
        role: "system",
        content: [
          { type: "input_text", text: "Be " },
          { type: "input_text", text: "brief." },
        ],
      },
    ];
    const result = transformResponseInput(input);
    expect(result).toEqual([{ role: "system", content: "Be brief." }]);
  });

  it("maps a developer-role message to a system message", () => {
    const input: ResponseInputItem[] = [
      { type: "message", role: "developer", content: "dev note" },
    ];
    const result = transformResponseInput(input);
    expect(result).toEqual([{ role: "system", content: "dev note" }]);
  });

  it("flattens an assistant-role message with parts to a string", () => {
    const input: ResponseInputItem[] = [
      { role: "user", content: "hi" },
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Hello" },
          { type: "output_text", text: " there" },
        ],
      },
      { role: "user", content: "more" },
    ];
    const result = transformResponseInput(input);
    expect(result[1]).toEqual({ role: "assistant", content: "Hello there" });
  });

  it("transforms an input_image part into an image content part", () => {
    const input: ResponseInputItem[] = [
      {
        role: "user",
        content: [
          { type: "input_text", text: "describe:" },
          { type: "input_image", image_url: "https://example.com/cat.png" },
        ],
      },
    ];
    const result = transformResponseInput(input);
    const parts = result[0].content as Array<{ type: string; image?: unknown }>;
    expect(parts[0]).toEqual({ type: "text", text: "describe:" });
    expect(parts[1].type).toBe("image");
    expect(parts[1].image).toBeInstanceOf(URL);
  });

  it("decodes a data: URL into raw image bytes with mediaType", () => {
    const input: ResponseInputItem[] = [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
    ];
    const result = transformResponseInput(input);
    const parts = result[0].content as Array<{ type: string; image: string; mediaType?: string }>;
    expect(parts[0]).toEqual({ type: "image", image: "AAAA", mediaType: "image/png" });
  });

  it("falls back to a raw string when an image_url is not a parseable URL", () => {
    const input: ResponseInputItem[] = [
      {
        role: "user",
        content: [{ type: "input_image", image_url: "not a url" }],
      },
    ];
    const result = transformResponseInput(input);
    const parts = result[0].content as Array<{ type: string; image: string }>;
    expect(parts[0]).toEqual({ type: "image", image: "not a url" });
  });

  it("skips an input_image part with no image_url", () => {
    const input: ResponseInputItem[] = [
      {
        role: "user",
        content: [
          { type: "input_text", text: "see:" },
          { type: "input_image" },
        ],
      },
    ];
    const result = transformResponseInput(input);
    const parts = result[0].content as Array<{ type: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text");
  });

  it("collapses an input_file part to a placeholder text reference", () => {
    const input: ResponseInputItem[] = [
      {
        role: "user",
        content: [
          { type: "input_file", filename: "report.pdf" },
          { type: "input_file", file_url: "https://x/y.txt" },
          { type: "input_file", file_id: "file_123" },
          { type: "input_file" },
        ],
      },
    ];
    const result = transformResponseInput(input);
    const parts = result[0].content as Array<{ type: string; text: string }>;
    expect(parts.map((p) => p.text)).toEqual([
      "[file: report.pdf]",
      "[file: https://x/y.txt]",
      "[file: file_123]",
    ]);
  });
});

describe("transformResponseInput — heterogeneous input items", () => {
  it("collapses consecutive function_call items into a single assistant tool-call message", () => {
    const input: ResponseInputItem[] = [
      { role: "user", content: "do two things" },
      { type: "function_call", call_id: "c1", name: "a", arguments: '{"x":1}' },
      { type: "function_call", call_id: "c2", name: "b", arguments: '{"y":2}' },
      { type: "function_call_output", call_id: "c1", output: "ra" },
      { type: "function_call_output", call_id: "c2", output: "rb" },
    ];
    const result = transformResponseInput(input);
    expect(result.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
    const calls = result[1].content as Array<{ type: string; toolCallId: string; toolName: string; input: unknown }>;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "a",
      input: { x: 1 },
    });
    expect(calls[1].toolCallId).toBe("c2");
  });

  it("falls back to the raw arguments string when JSON parsing fails", () => {
    const input: ResponseInputItem[] = [
      { type: "function_call", call_id: "c1", name: "a", arguments: "not json" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ];
    const result = transformResponseInput(input);
    const calls = result[0].content as Array<{ input: unknown }>;
    expect(calls[0].input).toBe("not json");
  });

  it("accepts a non-string arguments value on a function_call item", () => {
    const input: ResponseInputItem[] = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: "function_call", call_id: "c1", name: "a", arguments: { x: 1 } as any },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ];
    const result = transformResponseInput(input);
    const calls = result[0].content as Array<{ input: unknown }>;
    expect(calls[0].input).toEqual({ x: 1 });
  });

  it("defaults a function_call with null arguments to an empty object", () => {
    const input: ResponseInputItem[] = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: "function_call", call_id: "c1", name: "a", arguments: null as any },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ];
    const result = transformResponseInput(input);
    const calls = result[0].content as Array<{ input: unknown }>;
    expect(calls[0].input).toEqual({});
  });

  it("resolves the toolName on function_call_output by looking up the prior function_call's name", () => {
    const input: ResponseInputItem[] = [
      { type: "function_call", call_id: "c1", name: "search", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "result" },
    ];
    const result = transformResponseInput(input);
    const toolMsg = result[1];
    expect(toolMsg.role).toBe("tool");
    const parts = toolMsg.content as Array<{ type: string; toolName: string; output: unknown }>;
    expect(parts[0].toolName).toBe("search");
    expect(parts[0].output).toEqual({ type: "text", value: "result" });
  });

  it("uses 'unknown' as the toolName when no matching function_call exists", () => {
    const input: ResponseInputItem[] = [
      { type: "function_call_output", call_id: "orphan", output: "stray" },
    ];
    const result = transformResponseInput(input);
    const parts = result[0].content as Array<{ toolName: string; output: { value: string } }>;
    expect(parts[0].toolName).toBe("unknown");
    expect(parts[0].output.value).toBe("stray");
  });

  it("substitutes an empty string when function_call_output.output is missing", () => {
    const input: ResponseInputItem[] = [
      { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: "function_call_output", call_id: "c1" } as any,
    ];
    const result = transformResponseInput(input);
    const parts = result[1].content as Array<{ output: { value: string } }>;
    expect(parts[0].output.value).toBe("");
  });

  it("drops reasoning items entirely", () => {
    const input: ResponseInputItem[] = [
      { role: "user", content: "hi" },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "thinking" }],
      },
      { role: "user", content: "more" },
    ];
    const result = transformResponseInput(input);
    expect(result.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("treats a message item with no `type` field as a message (default branch)", () => {
    const input: ResponseInputItem[] = [
      { role: "user", content: "hello" },
    ];
    const result = transformResponseInput(input);
    expect(result).toEqual([{ role: "user", content: "hello" }]);
  });

  it("ignores unknown item types entirely", () => {
    const input: ResponseInputItem[] = [
      { role: "user", content: "hi" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: "weird_item", data: "ignored" } as any,
    ];
    const result = transformResponseInput(input);
    expect(result).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("transformResponseTools", () => {
  it("returns undefined for an undefined tools array", () => {
    expect(transformResponseTools(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty tools array", () => {
    expect(transformResponseTools([])).toBeUndefined();
  });

  it("returns a Record<name, CoreTool> for a flat function tool", () => {
    const tools: ResponseTool[] = [
      {
        type: "function",
        name: "calc",
        description: "do math",
        parameters: { type: "object", properties: { x: { type: "number" } } },
      },
    ];
    const result = transformResponseTools(tools);
    expect(result).toBeDefined();
    expect(Object.keys(result!)).toEqual(["calc"]);
    expect(result!.calc.description).toBe("do math");
    expect(result!.calc.inputSchema).toBeDefined();
  });

  it("filters out non-function tools (e.g. web_search_preview)", () => {
    const tools: ResponseTool[] = [
      { type: "web_search_preview" },
      {
        type: "function",
        name: "real_tool",
        parameters: { type: "object" },
      },
    ];
    const result = transformResponseTools(tools);
    expect(Object.keys(result!)).toEqual(["real_tool"]);
  });

  it("filters out function tools with no name", () => {
    const tools: ResponseTool[] = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: "function", parameters: { type: "object" } } as any,
      {
        type: "function",
        name: "kept",
        parameters: { type: "object" },
      },
    ];
    const result = transformResponseTools(tools);
    expect(Object.keys(result!)).toEqual(["kept"]);
  });

  it("returns undefined when every tool is filtered out", () => {
    const tools: ResponseTool[] = [
      { type: "web_search_preview" },
      { type: "file_search" },
    ];
    expect(transformResponseTools(tools)).toBeUndefined();
  });
});

describe("transformResponseToolChoice", () => {
  it("returns undefined when no tool_choice is provided", () => {
    expect(transformResponseToolChoice(undefined)).toBeUndefined();
  });

  it("passes through 'none' literally", () => {
    expect(transformResponseToolChoice("none")).toBe("none");
  });

  it("passes through 'auto' literally", () => {
    expect(transformResponseToolChoice("auto")).toBe("auto");
  });

  it("passes through 'required' literally", () => {
    expect(transformResponseToolChoice("required")).toBe("required");
  });

  it("rewrites a flat {type:'function', name} choice to {type:'tool', toolName}", () => {
    const choice: ResponseToolChoice = { type: "function", name: "search" };
    expect(transformResponseToolChoice(choice)).toEqual({
      type: "tool",
      toolName: "search",
    });
  });

  it("returns undefined for a function-typed choice with no name", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const choice = { type: "function" } as any;
    expect(transformResponseToolChoice(choice)).toBeUndefined();
  });

  it("returns undefined for an unknown object-typed choice", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const choice = { type: "weird" } as any;
    expect(transformResponseToolChoice(choice)).toBeUndefined();
  });
});



// ── Anthropic transformer tests ────────────────────────────────

describe("flattenSystem", () => {
  it("returns empty string for missing system", () => {
    expect(flattenSystem(undefined)).toBe("");
  });

  it("passes through string system", () => {
    expect(flattenSystem("be helpful")).toBe("be helpful");
  });

  it("concatenates only text blocks from an array system", () => {
    const sys: AnthropicSystem = [
      { type: "text", text: "A " },
      { type: "text", text: "B" },
    ];
    expect(flattenSystem(sys)).toBe("A B");
  });
});

describe("transformAnthropicMessages", () => {
  it("emits a system message before user content when system is set", () => {
    const out = transformAnthropicMessages(
      [{ role: "user", content: "hi" }],
      "be helpful",
    );
    expect(out[0]).toEqual({ role: "system", content: "be helpful" });
    expect(out[1].role).toBe("user");
  });

  it("inlines a base64 image source as an AI SDK image part", () => {
    const out = transformAnthropicMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "what?" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
        ],
      },
    ]);
    const userMsg = out.find((m) => m.role === "user");
    const parts = userMsg!.content as Array<{ type: string; image?: unknown; mediaType?: string }>;
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({ type: "image", image: "AAAA", mediaType: "image/png" });
  });

  it("converts a URL image source to a URL instance", () => {
    const out = transformAnthropicMessages([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: "https://example.com/x.png" } },
        ],
      },
    ]);
    const userMsg = out.find((m) => m.role === "user")!;
    const part = (userMsg.content as Array<{ image: URL }>)[0];
    expect(part.image).toBeInstanceOf(URL);
    expect((part.image as URL).href).toBe("https://example.com/x.png");
  });

  it("falls back to the raw string when the image url is not a valid URL", () => {
    const out = transformAnthropicMessages([
      {
        role: "user",
        content: [{ type: "image", source: { type: "url", url: "not a url" } }],
      },
    ]);
    const part = (out.find((m) => m.role === "user")!.content as Array<{ image: unknown }>)[0];
    expect(part.image).toBe("not a url");
  });

  it("splits a tool_result-bearing user message into tool + user messages", () => {
    const out = transformAnthropicMessages([
      { role: "assistant", content: [{ type: "tool_use", id: "id_1", name: "search", input: { q: "x" } }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "id_1", content: "found it" },
          { type: "text", text: "thanks" },
        ],
      },
    ]);
    const toolMsg = out.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const tr = (toolMsg!.content as Array<{ toolName: string; output: { value: string } }>)[0];
    expect(tr.toolName).toBe("search");
    expect(tr.output.value).toBe("found it");
    const finalUser = out[out.length - 1];
    expect(finalUser.role).toBe("user");
  });

  it("flattens an array tool_result content into plain text and drops images", () => {
    const out = transformAnthropicMessages([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "id_x",
            content: [
              { type: "text", text: "part-a " },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              { type: "text", text: "part-b" },
            ],
          },
        ],
      },
    ]);
    const tr = (out.find((m) => m.role === "tool")!.content as Array<{ output: { value: string } }>)[0];
    expect(tr.output.value).toBe("part-a part-b");
  });

  it("treats null tool_result content as empty string", () => {
    const out = transformAnthropicMessages([
      {
        role: "user",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        content: [{ type: "tool_result", tool_use_id: "id_y", content: null as any }],
      },
    ]);
    const tr = (out.find((m) => m.role === "tool")!.content as Array<{ output: { value: string } }>)[0];
    expect(tr.output.value).toBe("");
  });

  it("emits an empty user message when the user turn has no parts", () => {
    const out = transformAnthropicMessages([{ role: "user", content: [] }]);
    expect(out).toEqual([{ role: "user", content: "" }]);
  });

  it("handles mid-conversation system role as a system message (not assistant)", () => {
    // Claude Code injects a skills-list message with role:"system" mid-conversation.
    // Previously the else branch mis-classified it as assistant, flushing pending
    // nodes into chat_history and leaving message="" on the outbound payload.
    const out = transformAnthropicMessages(
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: "system" as any, content: "updated skills list" },
        { role: "user", content: "what can you do?" },
      ],
    );
    // There should be no assistant message whose content equals the system text
    const badAssistant = out.find(
      (m) => m.role === "assistant" && m.content === "updated skills list",
    );
    expect(badAssistant).toBeUndefined();
    // There should be a system message with the injected text
    const sysMsg = out.find(
      (m) => m.role === "system" && m.content === "updated skills list",
    );
    expect(sysMsg).toBeDefined();
    // The final message must be the user turn (not empty)
    const last = out[out.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toEqual([{ type: "text", text: "what can you do?" }]);
  });

  it("drops a mid-conversation system message that has no text content", () => {
    const out = transformAnthropicMessages(
      [
        { role: "user", content: "hi" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: "system" as any, content: "" },
        { role: "user", content: "again" },
      ],
    );
    const sysMsgs = out.filter((m) => m.role === "system");
    // Only 0 system messages (no top-level system was passed)
    expect(sysMsgs).toHaveLength(0);
    // Final user turn is intact
    const last = out[out.length - 1];
    expect(last.role).toBe("user");
  });
});

describe("transformAnthropicTools", () => {
  it("returns undefined for empty / missing tool list", () => {
    expect(transformAnthropicTools(undefined)).toBeUndefined();
    expect(transformAnthropicTools([])).toBeUndefined();
  });

  it("converts a well-formed tool to an AI SDK CoreTool entry", () => {
    const tools: AnthropicTool[] = [
      {
        name: "search",
        description: "find stuff",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
    ];
    const out = transformAnthropicTools(tools);
    expect(out).toBeDefined();
    expect(out!.search.description).toBe("find stuff");
    expect(out!.search.inputSchema).toBeDefined();
  });

  it("skips entries missing name or input_schema", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: any[] = [
      { description: "no name", input_schema: { type: "object" } },
      { name: "no_schema" },
      { name: "ok", input_schema: { type: "object" } },
    ];
    const out = transformAnthropicTools(tools);
    expect(out && Object.keys(out)).toEqual(["ok"]);
  });
});

describe("transformAnthropicToolChoice", () => {
  it("returns undefined when no choice is given", () => {
    expect(transformAnthropicToolChoice(undefined)).toBeUndefined();
  });

  it("maps each choice variant", () => {
    expect(transformAnthropicToolChoice({ type: "auto" })).toBe("auto");
    expect(transformAnthropicToolChoice({ type: "any" })).toBe("required");
    expect(transformAnthropicToolChoice({ type: "none" })).toBe("none");
    expect(transformAnthropicToolChoice({ type: "tool", name: "search" })).toEqual({
      type: "tool",
      toolName: "search",
    });
  });

  it("returns undefined for an unrecognised choice type", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const weird = { type: "weird" } as any as AnthropicToolChoice;
    expect(transformAnthropicToolChoice(weird)).toBeUndefined();
  });
});

describe("mapStopReason (Anthropic)", () => {
  it("maps known finishReasons", () => {
    expect(mapStopReason("stop")).toBe("end_turn");
    expect(mapStopReason("length")).toBe("max_tokens");
    expect(mapStopReason("tool-calls")).toBe("tool_use");
    expect(mapStopReason("tool_calls")).toBe("tool_use");
    expect(mapStopReason("content-filter")).toBe("refusal");
    expect(mapStopReason("content_filter")).toBe("refusal");
  });

  it("falls back to end_turn for unknown / undefined", () => {
    expect(mapStopReason(undefined)).toBe("end_turn");
    expect(mapStopReason("mystery")).toBe("end_turn");
  });
});

describe("thinkingToEffort", () => {
  it("returns undefined when thinking is disabled or missing", () => {
    expect(thinkingToEffort(undefined)).toBeUndefined();
    expect(thinkingToEffort({ type: "disabled" })).toBeUndefined();
  });

  it("defaults to low for non-numeric or non-positive budgets", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(thinkingToEffort({ type: "enabled" } as any)).toBe("low");
    expect(thinkingToEffort({ type: "enabled", budget_tokens: 0 })).toBe("low");
    expect(thinkingToEffort({ type: "enabled", budget_tokens: -10 })).toBe("low");
  });

  it("maps budgets to low / medium / high tiers", () => {
    expect(thinkingToEffort({ type: "enabled", budget_tokens: 4096 })).toBe("low");
    expect(thinkingToEffort({ type: "enabled", budget_tokens: 8000 })).toBe("medium");
    expect(thinkingToEffort({ type: "enabled", budget_tokens: 16384 })).toBe("medium");
    expect(thinkingToEffort({ type: "enabled", budget_tokens: 32000 })).toBe("high");
  });
});

describe("estimateTokenCount (Anthropic)", () => {
  it("returns at least 1 for an empty conversation", () => {
    expect(estimateTokenCount([])).toBe(1);
  });

  it("counts string content and the system prompt", () => {
    const messages: AnthropicMessage[] = [{ role: "user", content: "hello world" }];
    const n = estimateTokenCount(messages, "be helpful");
    // (11 + 10) / 4 = 5.25 → 6
    expect(n).toBe(6);
  });

  it("walks structured content blocks: text, tool_use, tool_result, thinking", () => {
    const messages: AnthropicMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "abcd" },
          { type: "tool_use", id: "x", name: "search", input: { q: "y" } },
          { type: "thinking", thinking: "1234" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "x", content: "okok" },
        ],
      },
    ];
    const n = estimateTokenCount(messages);
    expect(n).toBeGreaterThan(1);
  });
});