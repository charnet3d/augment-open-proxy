/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { patchModelForSignatures } from "../services/augmentSignaturePatch";

const GEMINI_ID = "toolu_aug_vrtx_gemini_abc123";
const ANTHROPIC_ID = "toolu_vrtx_018r8Sgnexb12M6";

function geminiPrompt(): any[] {
  return [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "think" },
        { type: "tool-call", toolCallId: GEMINI_ID, toolName: "T1", input: { q: 1 } },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: GEMINI_ID, toolName: "T1", output: { type: "text", value: "r1" } },
      ],
    },
  ];
}

describe("augmentSignaturePatch", () => {
  describe("buildPayload (flatten marker)", () => {
    it("does not flatten when marker is absent (default optimistic path)", () => {
      const inner = vi.fn().mockReturnValue({ ok: true });
      const model: any = { modelId: "butler_a", buildPayload: inner };
      patchModelForSignatures(model);

      model.buildPayload({ prompt: geminiPrompt() });

      const calledWith = inner.mock.calls[0][0];
      expect(calledWith.prompt[1].content[1].type).toBe("tool-call");
      expect(calledWith.prompt[1].content[1].toolCallId).toBe(GEMINI_ID);
      expect(calledWith.prompt[2].role).toBe("tool");
      expect(calledWith).not.toHaveProperty("__sigFlatten");
    });

    it("flattens only Gemini-routed turns when marker is set", () => {
      const inner = vi.fn().mockReturnValue({ ok: true });
      const model: any = { modelId: "butler_a", buildPayload: inner };
      patchModelForSignatures(model);

      const prompt: any[] = [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: ANTHROPIC_ID, toolName: "Anthro", input: {} }],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: ANTHROPIC_ID, toolName: "Anthro", output: { type: "text", value: "a" } },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: GEMINI_ID, toolName: "Gem", input: {} }],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: GEMINI_ID, toolName: "Gem", output: { type: "text", value: "g" } },
          ],
        },
      ];
      model.buildPayload({ prompt, __sigFlatten: true });

      const calledWith = inner.mock.calls[0][0];
      // Anthropic turn structured; Gemini turn flattened (assistant text +
      // user-role result message).
      expect(calledWith.prompt[0].role).toBe("assistant");
      expect(calledWith.prompt[0].content[0].type).toBe("tool-call");
      expect(calledWith.prompt[0].content[0].toolCallId).toBe(ANTHROPIC_ID);
      expect(calledWith.prompt[1].role).toBe("tool");
      expect(calledWith.prompt[1].content[0].toolCallId).toBe(ANTHROPIC_ID);
      expect(calledWith.prompt[2].role).toBe("assistant");
      expect(calledWith.prompt[2].content[0].type).toBe("text");
      expect(calledWith.prompt[2].content[0].text).toContain("[Assistant called tool: Gem");
      expect(calledWith.prompt[3].role).toBe("user");
      expect(calledWith.prompt[3].content[0].text).toContain("[Tool result for Gem: g]");
      expect(calledWith).not.toHaveProperty("__sigFlatten");
    });

    it("strips marker even when prompt has no Gemini turns", () => {
      const inner = vi.fn().mockReturnValue({ ok: true });
      const model: any = { modelId: "butler_a", buildPayload: inner };
      patchModelForSignatures(model);

      model.buildPayload({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        __sigFlatten: true,
      });

      const calledWith = inner.mock.calls[0][0];
      expect(calledWith).not.toHaveProperty("__sigFlatten");
      expect(calledWith.prompt[0].role).toBe("user");
    });
  });

  describe("doGenerate retry", () => {
    it("retries with flatten marker on signature error", async () => {
      const doGenerate = vi.fn()
        .mockRejectedValueOnce(new Error("Augment API error: 400 Bad Request - thought_signature missing"))
        .mockResolvedValueOnce({ ok: true });
      const model: any = { modelId: "butler_a", buildPayload: vi.fn(), doGenerate };
      patchModelForSignatures(model);

      const out = await model.doGenerate({ prompt: geminiPrompt() });

      expect(out).toEqual({ ok: true });
      expect(doGenerate).toHaveBeenCalledTimes(2);
      expect(doGenerate.mock.calls[0][0].__sigFlatten).toBeUndefined();
      expect(doGenerate.mock.calls[1][0].__sigFlatten).toBe(true);
    });

    it("does not retry on unrelated errors", async () => {
      const doGenerate = vi.fn().mockRejectedValue(new Error("network down"));
      const model: any = { modelId: "butler_a", buildPayload: vi.fn(), doGenerate };
      patchModelForSignatures(model);

      await expect(model.doGenerate({ prompt: geminiPrompt() })).rejects.toThrow("network down");
      expect(doGenerate).toHaveBeenCalledTimes(1);
    });
  });

  describe("doStream retry", () => {
    function streamOf(chunks: any[]): { stream: ReadableStream<any> } {
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
          },
        }),
      };
    }

    async function drain(s: ReadableStream<any>): Promise<any[]> {
      const reader = s.getReader();
      const out: any[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out.push(value);
      }
      return out;
    }

    it("retries when first chunk is a signature error", async () => {
      const doStream = vi.fn()
        .mockResolvedValueOnce(streamOf([{ type: "error", error: new Error("thought_signature required") }]))
        .mockResolvedValueOnce(streamOf([{ type: "text-delta", delta: "ok" }]));
      const model: any = { modelId: "butler_a", buildPayload: vi.fn(), doStream };
      patchModelForSignatures(model);

      const first = await model.doStream({ prompt: geminiPrompt() });
      const chunks = await drain(first.stream);

      expect(chunks).toEqual([{ type: "text-delta", delta: "ok" }]);
      expect(doStream).toHaveBeenCalledTimes(2);
      expect(doStream.mock.calls[1][0].__sigFlatten).toBe(true);
    });

    it("forwards non-signature error chunks without retry", async () => {
      const doStream = vi.fn()
        .mockResolvedValueOnce(streamOf([{ type: "error", error: new Error("unrelated") }]));
      const model: any = { modelId: "butler_a", buildPayload: vi.fn(), doStream };
      patchModelForSignatures(model);

      const first = await model.doStream({ prompt: geminiPrompt() });
      const chunks = await drain(first.stream);

      expect(chunks).toEqual([{ type: "error", error: expect.any(Error) }]);
      expect(doStream).toHaveBeenCalledTimes(1);
    });
  });
});
