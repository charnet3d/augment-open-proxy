import { describe, it, expect, vi } from "vitest";
import {
  mediaTypeToFormat,
  dataToBase64,
  hasAnyImage,
  buildChatRequestWithImages,
  ensureNonEmptyMessage,
  patchModelForImages,
} from "../services/augmentImagePatch";

describe("augmentImagePatch", () => {
  describe("mediaTypeToFormat", () => {
    it("maps known image media types to Augment format integers", () => {
      expect(mediaTypeToFormat("image/png")).toBe(1);
      expect(mediaTypeToFormat("image/jpeg")).toBe(2);
      expect(mediaTypeToFormat("image/jpg")).toBe(2);
      expect(mediaTypeToFormat("image/gif")).toBe(3);
      expect(mediaTypeToFormat("image/webp")).toBe(4);
    });

    it("falls back to PNG (1) for unknown / missing types", () => {
      expect(mediaTypeToFormat(undefined)).toBe(1);
      expect(mediaTypeToFormat("")).toBe(1);
      expect(mediaTypeToFormat("application/octet-stream")).toBe(1);
    });

    it("strips parameters and is case-insensitive", () => {
      expect(mediaTypeToFormat("Image/JPEG; charset=binary")).toBe(2);
    });
  });

  describe("dataToBase64", () => {
    it("returns string data unchanged (assumed already base64)", () => {
      expect(dataToBase64("aGVsbG8=")).toBe("aGVsbG8=");
    });

    it("encodes Uint8Array to base64", () => {
      expect(dataToBase64(new Uint8Array([104, 105]))).toBe("aGk=");
    });

    it("encodes ArrayBuffer to base64", () => {
      const buf = new Uint8Array([104, 105]).buffer;
      expect(dataToBase64(buf)).toBe("aGk=");
    });

    it("returns null for URL or unsupported data", () => {
      expect(dataToBase64(new URL("https://example.com/x.png"))).toBeNull();
      expect(dataToBase64(null)).toBeNull();
      expect(dataToBase64(undefined)).toBeNull();
      expect(dataToBase64(123)).toBeNull();
    });
  });

  describe("hasAnyImage", () => {
    it("detects image file parts in user messages", () => {
      expect(
        hasAnyImage([
          { role: "user", content: [{ type: "file", data: "x", mediaType: "image/png" }] },
        ]),
      ).toBe(true);
    });

    it("ignores non-image file parts and text-only prompts", () => {
      expect(hasAnyImage([{ role: "user", content: "hi" }])).toBe(false);
      expect(
        hasAnyImage([
          { role: "user", content: [{ type: "file", data: "x", mediaType: "application/pdf" }] },
        ]),
      ).toBe(false);
      expect(hasAnyImage(undefined)).toBe(false);
    });
  });

  describe("buildChatRequestWithImages", () => {
    it("emits IMAGE nodes (type 2) with image_node payload for image file parts", () => {
      const out = buildChatRequestWithImages(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" },
            ],
          },
        ],
        undefined,
      );
      expect(out.nodes).toHaveLength(2);
      expect(out.nodes[0]).toMatchObject({ id: 0, type: 0, text_node: { content: "What is this?" } });
      expect(out.nodes[1]).toMatchObject({
        id: 1,
        type: 2,
        image_node: { image_data: "AQID", format: 2 },
      });
      expect(out.message).toBe("What is this?");
      expect(out.chatHistory).toHaveLength(0);
    });

    it("skips file parts whose data can't be inlined (e.g. URL)", () => {
      const out = buildChatRequestWithImages(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "file", data: new URL("https://example.com/x.png"), mediaType: "image/png" },
            ],
          },
        ],
        undefined,
      );
      expect(out.nodes).toHaveLength(1);
      expect(out.nodes[0].type).toBe(0);
    });

    it("places images from previous user turns into chat_history.request_nodes", () => {
      const out = buildChatRequestWithImages(
        [
          {
            role: "user",
            content: [{ type: "file", data: "AAAA", mediaType: "image/webp" }],
          },
          { role: "assistant", content: "ok" },
          { role: "user", content: [{ type: "text", text: "follow up" }] },
        ],
        undefined,
      );
      expect(out.chatHistory).toHaveLength(1);
      const histNodes = out.chatHistory[0].request_nodes;
      const imgNode = histNodes.find((n: any) => n.type === 2);
      expect(imgNode).toBeDefined();
      expect(imgNode.image_node).toEqual({ image_data: "AAAA", format: 4 });
      expect(out.nodes).toHaveLength(1);
      expect(out.nodes[0].type).toBe(0);
    });

    it("emits System: prefix from a system message and joins it with the user text", () => {
      const out = buildChatRequestWithImages(
        [
          { role: "system", content: [{ type: "text", text: "be brief" }] },
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "file", data: "AAAA", mediaType: "image/png" },
            ],
          },
        ],
        undefined,
      );
      // System prepends a TEXT node with `System: ` prefix.
      expect(out.nodes[0]).toMatchObject({ type: 0, text_node: { content: "System: be brief" } });
      // Final concatenated message keeps both contributions, separated by a blank line.
      expect(out.message).toContain("System: be brief");
      expect(out.message).toContain("hello");
    });

    it("ignores empty system messages", () => {
      const out = buildChatRequestWithImages(
        [
          { role: "system", content: "" },
          { role: "user", content: [{ type: "file", data: "x", mediaType: "image/png" }] },
        ],
        undefined,
      );
      // Only the IMAGE node is present — no synthetic system text node.
      expect(out.nodes).toHaveLength(1);
      expect(out.nodes[0].type).toBe(2);
    });

    it("converts a tool-result message to a TOOL_RESULT node with text output", () => {
      const out = buildChatRequestWithImages(
        [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_1",
                output: { type: "text", value: "42" },
              },
            ],
          },
          { role: "user", content: [{ type: "file", data: "x", mediaType: "image/png" }] },
        ],
        undefined,
      );
      const trNode = out.nodes.find((n: any) => n.type === 1);
      expect(trNode).toBeDefined();
      expect(trNode.tool_result_node).toEqual({
        tool_use_id: "call_1",
        content: "42",
        is_error: false,
      });
    });

    it("serialises every tool-result output variant", () => {
      const out = buildChatRequestWithImages(
        [
          {
            role: "tool",
            content: [
              { type: "tool-result", toolCallId: "j", output: { type: "json", value: { ok: 1 } } },
              { type: "tool-result", toolCallId: "et", output: { type: "error-text", value: "boom" } },
              { type: "tool-result", toolCallId: "ej", output: { type: "error-json", value: { code: 1 } } },
              {
                type: "tool-result",
                toolCallId: "c",
                output: {
                  type: "content",
                  value: [
                    { type: "text", text: "a" },
                    { type: "image", data: "x" },
                    { type: "text", text: "b" },
                  ],
                },
              },
            ],
          },
          { role: "user", content: [{ type: "file", data: "x", mediaType: "image/png" }] },
        ],
        undefined,
      );
      const trNodes = out.nodes.filter((n: any) => n.type === 1);
      expect(trNodes).toHaveLength(4);
      expect(trNodes[0].tool_result_node).toMatchObject({ tool_use_id: "j", content: '{"ok":1}', is_error: false });
      expect(trNodes[1].tool_result_node).toMatchObject({ tool_use_id: "et", content: "boom", is_error: true });
      expect(trNodes[2].tool_result_node).toMatchObject({ tool_use_id: "ej", content: '{"code":1}', is_error: true });
      expect(trNodes[3].tool_result_node.content).toBe("a\nb");
    });

    it("emits an assistant turn's text, tool-call, and reasoning parts as response_nodes", () => {
      const out = buildChatRequestWithImages(
        [
          {
            role: "user",
            content: [{ type: "file", data: "AAAA", mediaType: "image/png" }],
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "answer " },
              { type: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "x" } },
              { type: "reasoning", text: "thinking..." },
            ],
          },
          { role: "user", content: [{ type: "text", text: "follow up" }] },
        ],
        undefined,
      );
      expect(out.chatHistory).toHaveLength(1);
      const respNodes = out.chatHistory[0].response_nodes;
      expect(respNodes.find((n: any) => n.type === 0 /* RAW_RESPONSE */)).toMatchObject({
        content: "answer ",
      });
      expect(respNodes.find((n: any) => n.type === 5 /* TOOL_USE */).tool_use).toMatchObject({
        tool_use_id: "c1",
        tool_name: "search",
        input_json: '{"q":"x"}',
      });
      expect(respNodes.find((n: any) => n.type === 8 /* THINKING */).thinking).toEqual({
        content: "thinking...",
      });
      expect(out.chatHistory[0].response_text).toBe("answer ");
    });

    it("stringifies an assistant tool-call whose input is already a JSON string", () => {
      const out = buildChatRequestWithImages(
        [
          {
            role: "user",
            content: [{ type: "file", data: "AAAA", mediaType: "image/png" }],
          },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "c1", toolName: "search", input: '{"q":"x"}' },
            ],
          },
          { role: "user", content: [{ type: "text", text: "ok" }] },
        ],
        undefined,
      );
      const tu = out.chatHistory[0].response_nodes.find((n: any) => n.type === 5);
      expect(tu.tool_use.input_json).toBe('{"q":"x"}');
    });

    it("converts function tool definitions to Augment shape", () => {
      const out = buildChatRequestWithImages(
        [{ role: "user", content: [{ type: "file", data: "x", mediaType: "image/png" }] }],
        [{ type: "function", name: "get_weather", description: "d", inputSchema: { type: "object" } }],
      );
      expect(out.toolDefinitions).toEqual([
        { name: "get_weather", description: "d", input_schema_json: '{"type":"object"}' },
      ]);
    });
  });

  describe("patchModelForImages", () => {
    it("delegates to original buildPayload when prompt has no images", () => {
      const original = vi.fn().mockReturnValue({ original: true });
      const model: any = { buildPayload: original, modelId: "m", sessionId: "s" };
      patchModelForImages(model);
      const result = model.buildPayload({ prompt: [{ role: "user", content: "hi" }] });
      expect(original).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ original: true });
      expect(model.supportsImageUrls).toBe(true);
    });

    it("builds an image-aware payload when an image is present", () => {
      const original = vi.fn();
      const model: any = { buildPayload: original, modelId: "claude-x", sessionId: "sess" };
      patchModelForImages(model);
      const payload = model.buildPayload({
        prompt: [
          {
            role: "user",
            content: [{ type: "file", data: "Zm9v", mediaType: "image/png" }],
          },
        ],
      });
      expect(original).not.toHaveBeenCalled();
      expect(payload).toMatchObject({
        mode: "CLI_AGENT",
        model: "claude-x",
        conversation_id: "sess",
      });
      expect(payload.nodes[0]).toMatchObject({
        type: 2,
        image_node: { image_data: "Zm9v", format: 1 },
      });
    });

    it("uses the provided mode for image-aware payloads instead of the CLI_AGENT default", () => {
      const original = vi.fn();
      const model: any = { buildPayload: original, modelId: "claude-sonnet-5-high", sessionId: "sess" };
      patchModelForImages(model, "CHAT");
      const payload = model.buildPayload({
        prompt: [
          {
            role: "user",
            content: [{ type: "file", data: "Zm9v", mediaType: "image/png" }],
          },
        ],
      });
      expect(original).not.toHaveBeenCalled();
      expect(payload).toMatchObject({ mode: "CHAT", model: "claude-sonnet-5-high" });
    });

    it("is a no-op when the model has no buildPayload (defensive)", () => {
      const model: any = { modelId: "m" };
      expect(() => patchModelForImages(model)).not.toThrow();
      expect(model.buildPayload).toBeUndefined();
    });

    it("fills empty SDK-built message with a placeholder when nodes carry content", () => {
      // Simulates the Claude Code tool-result-only turn: SDK's buildPayload
      // returns nodes with TOOL_RESULT but an empty `message`, which the
      // backend would reject ("Current user message is empty or contains
      // only whitespace").
      const original = vi.fn().mockReturnValue({
        message: "",
        nodes: [
          { id: 0, type: 1, tool_result_node: { tool_use_id: "c1", content: "42", is_error: false } },
        ],
      });
      const model: any = { buildPayload: original, modelId: "m", sessionId: "s" };
      patchModelForImages(model);
      const result = model.buildPayload({
        prompt: [
          { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", output: { type: "text", value: "42" } }] },
        ],
      });
      expect(result.message).toBe(".");
      expect(result.nodes).toHaveLength(1);
    });

    it("leaves SDK-built message untouched when it is already non-empty", () => {
      const original = vi.fn().mockReturnValue({ message: "hello", nodes: [] });
      const model: any = { buildPayload: original, modelId: "m", sessionId: "s" };
      patchModelForImages(model);
      const result = model.buildPayload({ prompt: [{ role: "user", content: "hello" }] });
      expect(result.message).toBe("hello");
    });

    it("does not inject placeholder when both message and nodes are empty (caller error)", () => {
      const original = vi.fn().mockReturnValue({ message: "", nodes: [] });
      const model: any = { buildPayload: original, modelId: "m", sessionId: "s" };
      patchModelForImages(model);
      const result = model.buildPayload({ prompt: [] });
      expect(result.message).toBe("");
    });
  });

  describe("ensureNonEmptyMessage", () => {
    it("replaces whitespace-only message when nodes carry content", () => {
      const out = ensureNonEmptyMessage({ message: "   \n", nodes: [{ id: 0, type: 1 }] });
      expect(out.message).toBe(".");
    });

    it("is a no-op when payload is null or non-object", () => {
      expect(ensureNonEmptyMessage(null)).toBeNull();
      expect(ensureNonEmptyMessage(undefined)).toBeUndefined();
    });

    it("is a no-op when message is not a string", () => {
      const payload: any = { nodes: [{ id: 0 }] };
      ensureNonEmptyMessage(payload);
      expect(payload.message).toBeUndefined();
    });

    it("sanitizes empty request_message entries in chat_history (snake_case)", () => {
      const payload: any = {
        message: "ok",
        nodes: [{ id: 0 }],
        chat_history: [
          { request_message: "hello", request_nodes: [{ id: 0 }], response_text: "hi", response_nodes: [] },
          { request_message: "", request_nodes: [{ id: 0, type: 1 }], response_text: "", response_nodes: [] },
          { request_message: "   ", request_nodes: [], response_text: "", response_nodes: [] },
        ],
      };
      ensureNonEmptyMessage(payload);
      expect(payload.chat_history[0].request_message).toBe("hello");
      expect(payload.chat_history[1].request_message).toBe(".");
      // Whitespace-only with no nodes is left alone (truly empty turn).
      expect(payload.chat_history[2].request_message).toBe("   ");
    });

    it("sanitizes empty request_message entries in chatHistory (camelCase)", () => {
      const payload: any = {
        message: "ok",
        nodes: [{ id: 0 }],
        chatHistory: [
          { request_message: "", request_nodes: [{ id: 0, type: 1 }], response_text: "", response_nodes: [] },
        ],
      };
      ensureNonEmptyMessage(payload);
      expect(payload.chatHistory[0].request_message).toBe(".");
    });
  });

  describe("buildChatRequestWithImages — empty message fallback", () => {
    it("injects placeholder when trailing message is tool-result-only", () => {
      const out = buildChatRequestWithImages(
        [
          { role: "user", content: [{ type: "text", text: "what is 6*7?" }] },
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "c1", toolName: "calc", input: { x: 42 } },
            ],
          },
          {
            role: "tool",
            content: [{ type: "tool-result", toolCallId: "c1", output: { type: "text", value: "42" } }],
          },
        ],
        undefined,
      );
      expect(out.message).toBe(".");
      const trNode = out.nodes.find((n: any) => n.type === 1);
      expect(trNode).toBeDefined();
    });

    it("injects placeholder for prior tool-result-only turns in chat_history", () => {
      // Conversation: user(text) → assistant(tool_use) → tool(tool_result) →
      // assistant(tool_use) → tool(tool_result). The middle history entry has
      // an empty request_message because its user-side was tool-result-only.
      const out = buildChatRequestWithImages(
        [
          { role: "user", content: [{ type: "text", text: "do X" }] },
          { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "t", input: {} }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", output: { type: "text", value: "r1" } }] },
          { role: "assistant", content: [{ type: "tool-call", toolCallId: "c2", toolName: "t", input: {} }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "c2", output: { type: "text", value: "r2" } }] },
        ],
        undefined,
      );
      expect(out.chatHistory).toHaveLength(2);
      expect(out.chatHistory[0].request_message).toBe("do X");
      expect(out.chatHistory[1].request_message).toBe(".");
      expect(out.message).toBe(".");
    });
  });
});
