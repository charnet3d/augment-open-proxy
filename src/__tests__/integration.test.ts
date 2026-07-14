/**
 * Integration tests for the full request flow.
 * 
 * Tests the complete request/response cycle through the Hono app
 * with the SDK fully mocked. Verifies assumptions A1-A8 from spec.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ── Mock the SDK at the module level ──────────────────────────
const mockResolveCredentials = vi.fn();
const mockDoGenerate = vi.fn();
const mockDoStream = vi.fn();

// Use a class-based mock so it works with `new AugmentLanguageModel(...)`
class MockAugmentLanguageModel {
  specificationVersion = "v2" as const;
  provider = "test-provider";
  modelId: string;
  constructor(modelId: string, _options: object) {
    this.modelId = modelId;
  }
  doGenerate = mockDoGenerate;
  doStream = mockDoStream;
}

vi.mock("@augmentcode/auggie-sdk", () => ({
  resolveAugmentCredentials: () => mockResolveCredentials(),
  AugmentLanguageModel: MockAugmentLanguageModel,
}));

// Prevent tests from spawning the real auggie binary — make execFile fail
// immediately so the model registry falls back to FALLBACK_MODEL_IDS.
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: object, cb: Function) =>
    cb(new Error("auggie not available in test environment"), "")
  ),
}));

describe("integration — full request flow", () => {
  let chatApp: Hono;
  let modelsApp: Hono;

  beforeEach(async () => {
    // Use mockClear() to preserve implementation while clearing call history
    mockResolveCredentials.mockClear();
    mockDoGenerate.mockClear();
    mockDoStream.mockClear();

    // Default: credentials resolve successfully
    mockResolveCredentials.mockResolvedValue({
      apiKey: "test-key",
      apiUrl: "https://api.test.com",
    });

    // Build fresh apps
    const { default: chatRouter } = await import("../routes/chat");
    const { default: modelsRouter } = await import("../routes/models");

    chatApp = new Hono();
    chatApp.route("/v1/chat", chatRouter);

    modelsApp = new Hono();
    modelsApp.route("/v1/models", modelsRouter);
  });

  describe("A1: SDK credential resolution", () => {
    it("should handle missing credentials gracefully", async () => {
      vi.resetModules();
      mockResolveCredentials.mockRejectedValue(new Error("No credentials"));

      const { validateCredentials } = await import("../services/augmentClient");
      const result = await validateCredentials();
      expect(result).toBe(false);
    });

    it("should succeed when credentials are available", async () => {
      vi.resetModules();
      mockResolveCredentials.mockResolvedValue({
        apiKey: "test-api-key",
        apiUrl: "https://api.augment.com",
      });

      const { validateCredentials } = await import("../services/augmentClient");
      const result = await validateCredentials();
      expect(result).toBe(true);
    });
  });

  describe("A2: Model ID validation", () => {
    it("should reject unknown non-claude models", async () => {
      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama-2-turbo",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const response = await chatApp.fetch(req);
      expect(response.status).toBe(404);

      const body: any = await response.json();
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.message).toContain("llama-2-turbo");
    });

    it("should accept claude- prefixed models not in registry (passthrough to SDK)", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "OK" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-new-future-model",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const response = await chatApp.fetch(req);
      expect(response.status).toBe(200);
    });
  });

  describe("A3: Message role transformation", () => {
    it("should transform system and user messages correctly", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Response" }],
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 2 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Hello" },
          ],
        }),
      });

      const response = await chatApp.fetch(req);
      expect(response.status).toBe(200);
      expect(mockDoGenerate).toHaveBeenCalled();
    });

    it("should handle tool role messages in conversation", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "I got the weather data." }],
        finishReason: "stop",
        usage: { inputTokens: 12, outputTokens: 6 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [
            { role: "user", content: "What's the weather?" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_123",
                  type: "function",
                  function: { name: "getWeather", arguments: '{"city":"NYC"}' },
                },
              ],
            },
            {
              role: "tool",
              content: '{"temp": 72}',
              tool_call_id: "call_123",
            },
          ],
        }),
      });

      const response = await chatApp.fetch(req);
      expect(response.status).toBe(200);
      expect(mockDoGenerate).toHaveBeenCalled();
    });
  });

  describe("A4: OpenAI tool format → AI SDK format transformation", () => {
    it("should transform OpenAI function tools to AI SDK format", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "OK" }],
        finishReason: "stop",
        usage: { inputTokens: 8, outputTokens: 1 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "What's the weather?" }],
          tools: [
            {
              type: "function",
              function: {
                name: "getWeather",
                description: "Get current weather",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                },
              },
            },
          ],
        }),
      });

      const response = await chatApp.fetch(req);
      expect(response.status).toBe(200);
      expect(mockDoGenerate).toHaveBeenCalled();

      const callArgs = mockDoGenerate.mock.calls[0][0];
      expect(callArgs.tools).toHaveLength(1);
      expect(callArgs.tools[0].name).toBe("getWeather");
      expect(callArgs.tools[0].description).toBe("Get current weather");
    });
  });

  describe("A5: SSE streaming format", () => {
    it("should send proper SSE format with initial chunk and [DONE]", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "Hello" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });

      const response = await chatApp.fetch(req);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      const reader = response.body?.getReader();
      const chunks: string[] = [];
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
      }

      const fullContent = chunks.join("");
      expect(fullContent).toContain("data: [DONE]");
      expect(fullContent).toContain('"role":"assistant"');
    });
  });

  describe("A6: Error responses match OpenAI format", () => {
    it("should return OpenAI error format for invalid model", async () => {
      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "nonexistent-model",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const response = await chatApp.fetch(req);
      const body: any = await response.json();

      expect(body.error).toBeDefined();
      expect(body.error.message).toBeDefined();
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe(404);
    });

    it("should return OpenAI error format for missing model field", async () => {
      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const response = await chatApp.fetch(req);
      const body: any = await response.json();

      expect(body.error).toBeDefined();
      expect(body.error.message).toContain("model");
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe(400);
    });
  });

  describe("A7: Non-streaming response format", () => {
    it("should match OpenAI chat.completion response schema", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [
          { type: "text", text: "Hello!" },
          { type: "text", text: " How can I help?" },
        ],
        finishReason: "stop",
        usage: { inputTokens: 15, outputTokens: 8 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const response = await chatApp.fetch(req);
      const body: any = await response.json();

      expect(body).toMatchObject({
        id: expect.stringMatching(/^chatcmpl-/),
        object: "chat.completion",
        created: expect.any(Number),
        model: "claude-sonnet-4-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello! How can I help?",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 15,
          completion_tokens: 8,
          total_tokens: 23,
        },
        system_fingerprint: "augment_open_proxy",
      });
    });

    it("should handle null content (tool-call only responses)", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [
          {
            type: "tool-call",
            toolCallId: "call_abc",
            toolName: "search",
            input: { query: "test" },
          },
        ],
        finishReason: "tool-calls",
        usage: { inputTokens: 6, outputTokens: 4 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "search for test" }],
        }),
      });

      const response = await chatApp.fetch(req);
      const body: any = await response.json();

      expect(body.choices[0].message.content).toBeNull();
      expect(body.choices[0].message.tool_calls).toHaveLength(1);
      expect(body.choices[0].finish_reason).toBe("tool_calls");
    });
  });

  describe("A8: Model list response format", () => {
    it("should match OpenAI models list schema", async () => {
      const response = await modelsApp.fetch(
        new Request("http://localhost/v1/models")
      );

      const body: any = await response.json();

      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);

      for (const model of body.data) {
        expect(model.object).toBe("model");
        expect(typeof model.id).toBe("string");
        expect(typeof model.created).toBe("number");
        expect(model.owned_by).toBe("augment");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // End-to-end user scenarios
  // These tests simulate realistic client workflows from first
  // request to last byte, verifying that every layer (routing,
  // transformation, streaming) cooperates correctly.
  // ─────────────────────────────────────────────────────────────

  describe("end-to-end: user fetches the available model list", () => {
    it("returns HTTP 200 with a non-empty OpenAI-formatted model list", async () => {
      const response = await modelsApp.fetch(
        new Request("http://localhost/v1/models")
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("application/json");

      const body: any = await response.json();

      // Top-level envelope
      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      // Every model entry must have all required fields
      for (const model of body.data) {
        expect(typeof model.id).toBe("string");
        expect(model.id.length).toBeGreaterThan(0);
        expect(model.object).toBe("model");
        expect(typeof model.created).toBe("number");
        expect(model.created).toBeGreaterThan(0);
        expect(model.owned_by).toBe("augment");
      }
    });
  });

  describe("end-to-end: user sends a simple chat message", () => {
    it("returns a complete, correctly shaped chat.completion response", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Paris is the capital of France." }],
        finishReason: "stop",
        usage: { inputTokens: 12, outputTokens: 8 },
      });

      const response = await chatApp.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-5",
            messages: [
              { role: "user", content: "What is the capital of France?" },
            ],
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("application/json");

      const body: any = await response.json();

      // Response envelope
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.object).toBe("chat.completion");
      expect(body.model).toBe("claude-sonnet-4-5");
      expect(typeof body.created).toBe("number");
      expect(body.created).toBeGreaterThan(0);

      // Assistant message
      expect(body.choices).toHaveLength(1);
      const choice = body.choices[0];
      expect(choice.index).toBe(0);
      expect(choice.message.role).toBe("assistant");
      expect(choice.message.content).toBe("Paris is the capital of France.");
      expect(choice.finish_reason).toBe("stop");

      // Token usage
      expect(body.usage).toMatchObject({
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 20,
      });

      // Augment-specific fingerprint
      expect(body.system_fingerprint).toBe("augment_open_proxy");
    });
  });

  describe("end-to-end: user streams a response", () => {
    it("delivers text as parseable SSE chunks and closes with [DONE]", async () => {
      const words = ["The ", "answer ", "is ", "42."];

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          for (const word of words) {
            controller.enqueue({ type: "text-delta", id: "t1", delta: word });
          }
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 4 } });
          controller.close();
        },
      });

      mockDoStream.mockResolvedValueOnce({ stream });

      const response = await chatApp.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-5",
            messages: [
              { role: "user", content: "What is the meaning of life?" },
            ],
            stream: true,
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      // Consume the full SSE stream into a string
      const streamReader = response.body!.getReader();
      const decoder = new TextDecoder();
      let rawSse = "";
      while (true) {
        const { done, value } = await streamReader.read();
        if (done) break;
        rawSse += decoder.decode(value, { stream: true });
      }

      // Split on SSE double-newline separator, drop blanks
      const events = rawSse
        .split("\n\n")
        .map((e) => e.trim())
        .filter(Boolean);

      // Stream must terminate with [DONE]
      expect(events.at(-1)).toBe("data: [DONE]");

      // Parse every event except the terminal [DONE]
      const dataEvents = events.slice(0, -1);
      const chunks = dataEvents.map((e) => {
        expect(e.startsWith("data: ")).toBe(true);
        return JSON.parse(e.slice("data: ".length));
      });

      // Every chunk must carry the standard streaming envelope
      for (const chunk of chunks) {
        expect(chunk.id).toMatch(/^chatcmpl-/);
        expect(chunk.object).toBe("chat.completion.chunk");
        expect(chunk.model).toBe("claude-sonnet-4-5");
        expect(typeof chunk.created).toBe("number");
        expect(Array.isArray(chunk.choices)).toBe(true);
      }

      // First chunk must establish the assistant role
      expect(chunks[0].choices[0].delta).toMatchObject({ role: "assistant" });

      // Reconstruct the full text from content deltas (skip the role chunk and any non-content chunks)
      const reconstructed = chunks
        .slice(1)
        .map((c: any) => c.choices[0]?.delta?.content ?? "")
        .join("");

      expect(reconstructed).toBe("The answer is 42.");
    });
  });
});
