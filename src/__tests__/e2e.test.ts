/**
 * End-to-end tests against the real Augment API.
 *
 * These tests load credentials from .env and make actual calls to the
 * Augment backend — no mocks anywhere in this file.
 *
 * They are skipped automatically when no credentials are detected so that
 * CI environments without secrets stay green.
 *
 * Run locally after `auggie login` or with a populated .env file:
 *   AUGMENT_API_KEY=… AUGMENT_API_URL=… npm test
 *   — or —
 *   npm test  (picks up .env automatically)
 */

// Load .env before any module-level credential check.
// config.ts calls dotenv internally, but that happens after static imports
// are resolved. Importing it first guarantees .env is parsed before we
// inspect process.env below.
import "../config";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { expandShortName, expandModelEntry, getEffortDisabledBaseIds } from "../services/modelRegistry";

const execFileAsync = promisify(execFile);

// ── Credential detection ──────────────────────────────────────────────────────
// Accept either an API key pair (env) or a session written by `auggie login`.
const hasEnvCredentials =
  !!(process.env.AUGMENT_API_KEY && process.env.AUGMENT_API_URL);
const hasSessionFile = existsSync(
  join(homedir(), ".augment", "session.json")
);
const credentialsAvailable = hasEnvCredentials || hasSessionFile;

// ── CLI availability ──────────────────────────────────────────────────────────
// Use shell:true so the OS can find .cmd wrappers installed by npm on Windows.
// spawnSync is synchronous, which lets us decide at module load time whether
// to skip CLI-dependent tests — no async ceremony required.
const cliProbe = spawnSync("auggie", ["--help"], {
  timeout: 5_000,
  shell: true,
  stdio: "ignore",
});
const cliAvailable = !cliProbe.error && cliProbe.status === 0;

// ── CLI helper ────────────────────────────────────────────────────────────────
interface CliResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

async function runAuggieCli(): Promise<CliResult> {
  try {
    const { stdout } = await execFileAsync(
      "auggie",
      ["models", "list", "--json"],
      // shell:true is required on Windows for npm-installed .cmd binaries.
      { timeout: 15_000, shell: true }
    );
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stdout: "", error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Responses-API SSE helpers ────────────────────────────────────────────────
// Responses-API SSE frames carry `event: <type>` plus `data: <json>` per
// event (unlike chat-completions which only uses `data:`). Parse both.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseResponsesSse(raw: string): Array<{ event: string; data: any }> {
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: ")) ?? "";
      const dataLine = lines.find((l) => l.startsWith("data: ")) ?? "";
      return {
        event: eventLine.slice("event: ".length),
        data: dataLine ? JSON.parse(dataLine.slice("data: ".length)) : null,
      };
    });
}

async function drainStream(response: Response): Promise<string> {
  const bodyStream = response.body;
  if (!bodyStream) throw new Error("Response body is null");
  const reader = bodyStream.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  return raw;
}

// ── Suite ─────────────────────────────────────────────────────────────────────
// The whole suite is skipped when credentials are absent.
const describeE2E = credentialsAvailable ? describe : describe.skip;

describeE2E("e2e — real Augment API", () => {
  let app: Hono;
  // Populated in beforeAll with the first model the registry actually returns.
  // This avoids hardcoding a model ID that may not exist on the user's account.
  let testModelId = "claude-sonnet-4-5";

  beforeAll(async () => {
    // Import the real routes — no vi.mock in this file, so the real SDK is used.
    const { default: chatRouter } = await import("../routes/chat");
    const { default: modelsRouter } = await import("../routes/models");
    const { default: messagesRouter } = await import("../routes/messages");
    const { default: responsesRouter } = await import("../routes/responses");

    app = new Hono();
    app.route("/v1/chat", chatRouter);
    app.route("/v1/models", modelsRouter);
    app.route("/v1/messages", messagesRouter);
    app.route("/v1/responses", responsesRouter);

    // Discover a real model to use for the chat tests below.
    const res = await app.fetch(new Request("http://localhost/v1/models"));
    if (res.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await res.json();
      const first = body.data?.[0];
      if (first?.id) testModelId = first.id as string;
    }
  }, 20_000);

  // ── auggie CLI smoke-test ─────────────────────────────────────────────────
  // Skipped automatically when `auggie` is not resolvable in the system PATH.
  describe.skipIf(!cliAvailable)("auggie models list --json", () => {
    it("exits successfully and returns a non-empty model array", async () => {
      const result = await runAuggieCli();

      expect(result.ok, `auggie CLI failed: ${result.error}`).toBe(true);

      const data = JSON.parse(result.stdout.trim()) as {
        registryAvailable?: boolean;
        models?: Array<{ shortName?: string }>;
      };

      const models = data.models ?? [];
      expect(Array.isArray(data.models), "response has no models array").toBe(true);
      expect(models.length, "model list is empty").toBeGreaterThan(0);

      for (const m of models) {
        expect(typeof m.shortName).toBe("string");
        expect((m.shortName ?? "").length).toBeGreaterThan(0);
      }
    }, 20_000);
  });

  // ── GET /v1/models ────────────────────────────────────────────────────────
  describe("GET /v1/models", () => {
    // Requires auggie CLI so we can compare the API output against the ground truth.
    it.skipIf(!cliAvailable)("returns the real CLI model list — not the hardcoded fallback", async () => {
      // 1. Run auggie independently to capture the ground truth.
      const cliResult = await runAuggieCli();
      expect(cliResult.ok, `auggie CLI failed: ${cliResult.error}`).toBe(true);

      const cliData = JSON.parse(cliResult.stdout.trim()) as {
        models?: Array<{ shortName?: string; effortLevels?: unknown }>;
      };
      // Mirror the registry's fetchModelEntries logic exactly: expand short
      // names, parse effortLevels, honour AUGMENT_DISABLE_EFFORT_MODELS, then
      // flatten base + suffixed variants so both sides are comparable.
      const disabled = getEffortDisabledBaseIds();
      const cliIds = (cliData.models ?? [])
        .filter((m): m is { shortName: string; effortLevels?: unknown } =>
          typeof m.shortName === "string" && m.shortName.length > 0
        )
        .flatMap((m) => {
          const baseId = expandShortName(m.shortName);
          const advertised = Array.isArray(m.effortLevels)
            ? m.effortLevels
                .filter((l): l is string => typeof l === "string" && l.length > 0)
                .map((l) => l.toLowerCase())
            : [];
          const effortLevels = advertised.filter(
            (level) => !disabled.has(baseId) && !disabled.has(`${baseId}-${level}`)
          );
          return expandModelEntry({ baseId, effortLevels });
        })
        .sort((a, b) => a.localeCompare(b));

      // 2. Fetch via the proxy.
      const response = await app.fetch(new Request("http://localhost/v1/models"));
      expect(response.status).toBe(200);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      const apiIds: string[] = (body.data as { id: string }[])
        .map((m) => m.id)
        .sort((a, b) => a.localeCompare(b));

      // 3. The proxy must serve exactly what the CLI reported.
      //    A mismatch here means the registry fell back to the hardcoded list.
      expect(apiIds).toEqual(cliIds);
    }, 20_000);

    it("formats every entry as an OpenAI model object", async () => {
      const response = await app.fetch(new Request("http://localhost/v1/models"));
      expect(response.status).toBe(200);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      for (const model of body.data) {
        expect(typeof model.id).toBe("string");
        expect(model.id.length).toBeGreaterThan(0);
        expect(model.object).toBe("model");
        expect(typeof model.created).toBe("number");
        expect(model.created).toBeGreaterThan(0);
        expect(model.owned_by).toBe("augment");
      }
    }, 20_000);
  });

  // ── POST /v1/chat/completions (non-streaming) ─────────────────────────────
  describe("POST /v1/chat/completions (non-streaming)", () => {
    it("returns a real assistant reply with a correct OpenAI response shape", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            messages: [
              {
                role: "user",
                content: 'Reply with exactly the word "pong" and nothing else.',
              },
            ],
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();

      // Envelope
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.object).toBe("chat.completion");
      expect(body.model).toBe(testModelId);
      expect(typeof body.created).toBe("number");
      expect(body.system_fingerprint).toBe("augment_open_proxy");

      // Assistant message
      expect(body.choices).toHaveLength(1);
      const choice = body.choices[0];
      expect(choice.index).toBe(0);
      expect(choice.message.role).toBe("assistant");
      expect(typeof choice.message.content).toBe("string");
      expect((choice.message.content as string).toLowerCase()).toContain("pong");
      expect(choice.finish_reason).toBe("stop");

      // Token usage — must be real non-zero numbers
      expect(body.usage.prompt_tokens).toBeGreaterThan(0);
      expect(body.usage.completion_tokens).toBeGreaterThan(0);
      expect(body.usage.total_tokens).toBe(
        body.usage.prompt_tokens + body.usage.completion_tokens
      );
    }, 30_000);
  });

  // ── Shared tool definition used by the tool-calling tests ───────────────────
  // tool_choice:"required" guarantees the model will call the tool, making the
  // test deterministic regardless of model version.
  const weatherTool = {
    type: "function" as const,
    function: {
      name: "get_current_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "The city name, e.g. Paris" },
        },
        required: ["city"],
      },
    },
  };

  // ── POST /v1/chat/completions (tool calling, non-streaming) ──────────────
  describe("POST /v1/chat/completions (tool calling, non-streaming)", () => {
    it("returns a tool_calls response with the correct OpenAI shape", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            messages: [{ role: "user", content: "What is the weather in Paris?" }],
            tools: [weatherTool],
            tool_choice: "required",
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();

      // Standard envelope
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.object).toBe("chat.completion");
      expect(body.model).toBe(testModelId);
      expect(typeof body.created).toBe("number");

      // The model was forced to call a tool
      expect(body.choices).toHaveLength(1);
      const choice = body.choices[0];
      expect(choice.finish_reason).toBe("tool_calls");
      expect(Array.isArray(choice.message.tool_calls)).toBe(true);
      expect(choice.message.tool_calls.length).toBeGreaterThan(0);

      // Tool call shape
      const tc = choice.message.tool_calls[0];
      expect(typeof tc.id).toBe("string");
      expect(tc.id.length).toBeGreaterThan(0);
      expect(tc.type).toBe("function");
      expect(tc.function.name).toBe("get_current_weather");

      // Arguments must be a valid JSON object with the city field
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = JSON.parse(tc.function.arguments);
      expect(typeof args.city).toBe("string");
      expect(args.city.length).toBeGreaterThan(0);
    }, 30_000);
  });

  // ── POST /v1/chat/completions (streaming) ─────────────────────────────────
  describe("POST /v1/chat/completions (streaming)", () => {
    it("delivers a real SSE stream whose deltas reconstruct a valid reply", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            messages: [
              {
                role: "user",
                content: 'Reply with exactly the word "pong" and nothing else.',
              },
            ],
            stream: true,
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      // Drain the full SSE stream.
      const bodyStream = response.body;
      if (!bodyStream) throw new Error("Response body is null");
      const reader = bodyStream.getReader();
      const decoder = new TextDecoder();
      let rawSse = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawSse += decoder.decode(value, { stream: true });
      }

      // Parse events (split on SSE double-newline, strip blanks).
      const events = rawSse
        .split("\n\n")
        .map((e) => e.trim())
        .filter(Boolean);

      // Stream must terminate with [DONE].
      expect(events.at(-1)).toBe("data: [DONE]");

      // Parse every data event except [DONE].
      const chunks = events.slice(0, -1).map((e) => {
        expect(e.startsWith("data: ")).toBe(true);
        return JSON.parse(e.slice("data: ".length));
      });

      // Every chunk carries the standard streaming envelope.
      for (const chunk of chunks) {
        expect(chunk.id).toMatch(/^chatcmpl-/);
        expect(chunk.object).toBe("chat.completion.chunk");
        expect(chunk.model).toBe(testModelId);
        expect(Array.isArray(chunk.choices)).toBe(true);
      }

      // First chunk establishes the assistant role.
      expect(chunks[0].choices[0].delta).toMatchObject({ role: "assistant" });

      // Reconstruct the full reply from content deltas (skip the role chunk).
      const reconstructed = chunks
        .slice(1)
        .map((c: any) => c.choices[0].delta.content ?? "")
        .join("");

      expect(reconstructed.length).toBeGreaterThan(0);
      expect(reconstructed.toLowerCase()).toContain("pong");
    }, 30_000);
  });

  // ── POST /v1/chat/completions (multi-turn) ───────────────────────────────
  describe("POST /v1/chat/completions (multi-turn)", () => {
    it("retains context across two sequential requests", async () => {
      // Turn 1: establish a fact.
      const res1 = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            messages: [{ role: "user", content: "What is 2+2? Reply with the number only." }],
          }),
        })
      );
      expect(res1.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body1: any = await res1.json();
      const assistantReply: string = body1.choices[0].message.content;
      expect(assistantReply.trim()).toContain("4");

      // Turn 2: follow up — the model must know the prior answer.
      const res2 = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            messages: [
              { role: "user", content: "What is 2+2? Reply with the number only." },
              { role: "assistant", content: assistantReply },
              { role: "user", content: "Multiply that by 3. Reply with the number only." },
            ],
          }),
        })
      );
      expect(res2.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body2: any = await res2.json();
      const followUp: string = body2.choices[0].message.content;
      // 4 × 3 = 12
      expect(followUp).toContain("12");

      // Standard response shape checks.
      expect(body2.id).toMatch(/^chatcmpl-/);
      expect(body2.object).toBe("chat.completion");
      expect(body2.choices[0].finish_reason).toBe("stop");
      expect(body2.usage.prompt_tokens).toBeGreaterThan(0);
    }, 60_000);
  });

  // ── POST /v1/chat/completions (tool calling, streaming) ──────────────────
  describe("POST /v1/chat/completions (tool calling, streaming)", () => {
    it("streams tool call chunks with the correct OpenAI SSE shape", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            messages: [{ role: "user", content: "What is the weather in Paris?" }],
            tools: [weatherTool],
            tool_choice: "required",
            stream: true,
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      // Drain the SSE stream.
      const bodyStream = response.body;
      if (!bodyStream) throw new Error("Response body is null");
      const reader = bodyStream.getReader();
      const decoder = new TextDecoder();
      let rawSse = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawSse += decoder.decode(value, { stream: true });
      }

      // Parse events (split on SSE double-newline, strip blanks).
      const events = rawSse
        .split("\n\n")
        .map((e) => e.trim())
        .filter(Boolean);

      // Stream must terminate with [DONE].
      expect(events.at(-1)).toBe("data: [DONE]");

      // Parse all data events except [DONE].
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chunks: any[] = events.slice(0, -1).map((e) => {
        expect(e.startsWith("data: ")).toBe(true);
        return JSON.parse(e.slice("data: ".length));
      });

      // All chunks carry the standard streaming envelope.
      for (const chunk of chunks) {
        expect(chunk.id).toMatch(/^chatcmpl-/);
        expect(chunk.object).toBe("chat.completion.chunk");
        expect(chunk.model).toBe(testModelId);
        expect(Array.isArray(chunk.choices)).toBe(true);
      }

      // First chunk establishes the assistant role.
      expect(chunks[0].choices[0].delta).toMatchObject({ role: "assistant" });

      // Collect chunks that carry tool_calls deltas (skip the role chunk).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolChunks = chunks.slice(1).filter((c: any) => c.choices[0].delta.tool_calls?.length > 0);
      expect(toolChunks.length).toBeGreaterThan(0);

      // The first tool_calls chunk must introduce the tool call: id, type, name.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const firstTc = toolChunks[0].choices[0].delta.tool_calls[0];
      expect(typeof firstTc.id).toBe("string");
      expect(firstTc.id.length).toBeGreaterThan(0);
      expect(firstTc.type).toBe("function");
      expect(firstTc.function.name).toBe("get_current_weather");

      // Reconstruct the full arguments string by concatenating all argument deltas.
      const allArgs = toolChunks
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .flatMap((c: any) => c.choices[0].delta.tool_calls as any[])
        .map((tc) => tc.function?.arguments ?? "")
        .join("");

      // Must be valid JSON containing a city field.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = JSON.parse(allArgs);
      expect(typeof args.city).toBe("string");
      expect(args.city.length).toBeGreaterThan(0);

      // The final chunk (before [DONE]) must signal tool_calls completion.
      expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
    }, 30_000);
  });

  // ── POST /v1/chat/completions (image input — experimental) ──────────────
  // Mirrors the OpenWebUI request shape that originally surfaced the image
  // drop-through bug: a user message with mixed text + image_url parts where
  // the URL is a base64 data URL. Exercises the runtime SDK patch end-to-end.
  describe("POST /v1/chat/completions (image input)", () => {
    let visionModelId = "";

    beforeAll(async () => {
      const res = await app.fetch(new Request("http://localhost/v1/models"));
      if (res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json();
        const ids: string[] = (body.data ?? []).map((m: { id: string }) => m.id);
        // Prefer Claude — universally vision-capable on Augment — then fall
        // back to GPT/Gemini, then to whatever the discovery picked.
        visionModelId =
          ids.find((id) => id.startsWith("claude-sonnet")) ??
          ids.find((id) => id.startsWith("claude-haiku")) ??
          ids.find((id) => id.startsWith("claude")) ??
          ids.find((id) => id.startsWith("gpt-")) ??
          ids.find((id) => id.startsWith("gemini")) ??
          testModelId;
      } else {
        visionModelId = testModelId;
      }
    }, 20_000);

    // Tiny 66×75 PNG captured from a real OpenWebUI request body.
    const PNG_DATA_URL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEIAAABLCAYAAADEW1EgAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAHMSURBVHhe7ZphasMwDEZ7jcLon+wE7f1PNEaP0GFwIDzs2HHMYlnfA/2SZKxndWx0t5sQQgghhBiXn8fy+v36/pQi1LF3GmolTC+EQ9bGVDK4DbnhWFfTY4qjA+WEsM4UHIr5HOyrlTgkHKZlkClkcAjma6DM1nMuhQO0vihltJxxGbz82RftccYl8OJnX5NiW8/5dyigx+V5HvNDwkv3kMGtYH5IKIDRKsScCL5eKthTw9n+y8gJcbMRWyiB+SP0OucSuBWt2xAwLSLArWiVYV4Et6JVhnkRgZQM1pQ40zsUlPF+LM9UPrct04gIUMZ28NKgpbw53vflSRkM9gRKeZOkNqM0aClvmj0h/FkxtYjAnoxc8IxpOCqD/VPBYXPBj8x0uHnxEhIRkYiIREQkIiIREYmIuBRR+k2S9dNREuBCRK2EqUWkJPBvBoqo6TFF7UAUwZ5S//BwCOZXWJMSyDAjhMPsXXytTdXwHEaqZyh4YeaPsieEtUOxvXjPV6OQnmcPwd7Hww18ZeZdQAluRVCCy48Gt8GlhAC3gXkX8AvhsA0uNyQ1MDfEhYx1I7b/NMKNcCMjR0qIZEhGWgZr3LCV4XYjhBBCiHH5Azu2MNsH4SA7AAAAAElFTkSuQmCC";

    it("accepts an OpenAI-style image_url part and returns a response that acknowledges the image", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: visionModelId,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "what can you see ?" },
                  { type: "image_url", image_url: { url: PNG_DATA_URL } },
                ],
              },
            ],
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();

      // Standard OpenAI envelope.
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.object).toBe("chat.completion");
      expect(body.model).toBe(visionModelId);
      expect(body.choices).toHaveLength(1);

      const choice = body.choices[0];
      expect(choice.message.role).toBe("assistant");
      expect(typeof choice.message.content).toBe("string");
      expect((choice.message.content as string).length).toBeGreaterThan(0);
      expect(choice.finish_reason).toBe("stop");

      // The original bug: the SDK silently dropped the image and the model
      // replied with "no image was attached". Assert the reply does *not*
      // claim the image is missing — that's the regression guard.
      const reply = (choice.message.content as string).toLowerCase();
      const droppedImagePhrases = [
        "no image",
        "wasn't attached",
        "wasn't provided",
        "was not attached",
        "was not provided",
        "didn't receive",
        "did not receive",
        "no attachment",
        "i can't see",
        "i cannot see",
        "i don't see",
        "i do not see",
        "unable to see",
      ];
      for (const phrase of droppedImagePhrases) {
        expect(
          reply,
          `model replied as if no image was attached: ${reply}`,
        ).not.toContain(phrase);
      }

      // Usage shape stays consistent.
      expect(body.usage).toBeDefined();
      expect(typeof body.usage.prompt_tokens).toBe("number");
      expect(typeof body.usage.completion_tokens).toBe("number");
      expect(body.usage.total_tokens).toBe(
        body.usage.prompt_tokens + body.usage.completion_tokens
      );
    }, 60_000);
  });

  // ── POST /v1/chat/completions (reasoning) ────────────────────────────────
  // The Augment SDK does not currently forward `reasoningEffort` upstream,
  // so the test does not assert that reasoning content *must* be returned.
  // It does assert that:
  //   1. Supplying reasoning params (top-level + nested) does not break the
  //      request — response shape stays OpenAI-compatible.
  //   2. When the upstream *does* emit reasoning (THINKING nodes), the
  //      proxy surfaces it as `reasoning_content` (DeepSeek/OpenRouter
  //      convention; what Open WebUI / aider / cline / litellm consume).
  // Prefer a reasoning-capable model when one is in the registry (gpt-5*).
  describe("POST /v1/chat/completions (reasoning)", () => {
    let reasoningModelId = "";

    beforeAll(async () => {
      const res = await app.fetch(new Request("http://localhost/v1/models"));
      if (res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json();
        const ids: string[] = (body.data ?? []).map((m: { id: string }) => m.id);
        reasoningModelId =
          ids.find((id) => id.startsWith("gpt-5")) ??
          ids.find((id) => /thinking|reasoning/.test(id)) ??
          testModelId;
      } else {
        reasoningModelId = testModelId;
      }
    }, 20_000);

    it("accepts reasoning_effort and returns a valid OpenAI response (non-streaming)", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: reasoningModelId,
            messages: [
              {
                role: "user",
                content:
                  "Think step by step. How many distinct prime factors does 30 have? Reply with only the digit.",
              },
            ],
            reasoning_effort: "high",
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();

      // Envelope stays valid even with reasoning_effort present.
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.object).toBe("chat.completion");
      expect(body.model).toBe(reasoningModelId);
      expect(body.choices).toHaveLength(1);
      expect(body.choices[0].message.role).toBe("assistant");
      expect(typeof body.choices[0].message.content).toBe("string");
      expect((body.choices[0].message.content as string).length).toBeGreaterThan(0);
      expect(body.choices[0].finish_reason).toBe("stop");
      // Usage shape must stay consistent. Some reasoning-capable backends do
      // not report per-call token counts, so we only assert internal
      // consistency rather than a positive prompt_tokens value.
      expect(body.usage).toBeDefined();
      expect(typeof body.usage.prompt_tokens).toBe("number");
      expect(typeof body.usage.completion_tokens).toBe("number");
      expect(body.usage.total_tokens).toBe(
        body.usage.prompt_tokens + body.usage.completion_tokens
      );

      // If the upstream surfaced reasoning, it must be a non-empty string
      // under `reasoning_content` (DeepSeek/OpenRouter convention).
      const reasoning = body.choices[0].message.reasoning_content;
      if (reasoning !== undefined) {
        expect(typeof reasoning).toBe("string");
        expect(reasoning.length).toBeGreaterThan(0);
      }
    }, 60_000);

    it("accepts reasoning {effort, summary} and emits valid streaming chunks", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: reasoningModelId,
            messages: [
              {
                role: "user",
                content:
                  "Think step by step. What is 7 + 5? Reply with only the digits.",
              },
            ],
            stream: true,
            reasoning: { effort: "medium", summary: "concise" },
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      const bodyStream = response.body;
      if (!bodyStream) throw new Error("Response body is null");
      const reader = bodyStream.getReader();
      const decoder = new TextDecoder();
      let rawSse = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawSse += decoder.decode(value, { stream: true });
      }

      const events = rawSse.split("\n\n").map((e) => e.trim()).filter(Boolean);
      expect(events.at(-1)).toBe("data: [DONE]");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chunks: any[] = events.slice(0, -1).map((e) => {
        expect(e.startsWith("data: ")).toBe(true);
        return JSON.parse(e.slice("data: ".length));
      });

      for (const chunk of chunks) {
        expect(chunk.id).toMatch(/^chatcmpl-/);
        expect(chunk.object).toBe("chat.completion.chunk");
        expect(chunk.model).toBe(reasoningModelId);
        expect(Array.isArray(chunk.choices)).toBe(true);
      }
      expect(chunks[0].choices[0].delta).toMatchObject({ role: "assistant" });

      // Reply must still be reconstructible from content deltas.
      const reconstructed = chunks
        .slice(1)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => c.choices[0].delta.content ?? "")
        .join("");
      expect(reconstructed.length).toBeGreaterThan(0);

      // Any delta.reasoning_content chunks emitted must be plain strings
      // (DeepSeek/OpenRouter convention consumed by Open WebUI et al.).
      const reasoningChunks = chunks
        .slice(1)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((c: any) => typeof c.choices[0].delta.reasoning_content === "string");
      for (const rc of reasoningChunks) {
        const r = rc.choices[0].delta.reasoning_content;
        expect(typeof r).toBe("string");
      }

      // Final chunk must report a normal stop (not an error).
      expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    }, 60_000);
  });

  // ── POST /v1/chat/completions (reasoning effort → model suffix) ──────────
  // Augment encodes reasoning depth in the model ID itself
  // (e.g. `claude-opus-4-7-high`). The proxy exposes both forms:
  //   1. The suffixed ID directly in /v1/models, so clients can target it.
  //   2. The base ID + `reasoning_effort` body field, which the proxy rewrites
  //      to the suffixed ID before calling the backend.
  // This suite verifies BOTH paths return 200 against the live API for a
  // model that actually advertises effort levels (and is not muted via
  // AUGMENT_DISABLE_EFFORT_MODELS), proving the suffixing isn't 404'd.
  describe("POST /v1/chat/completions (reasoning effort suffixing)", () => {
    // Resolved in beforeAll: a base model ID, one of its advertised effort
    // suffixes, and the corresponding suffixed ID.
    let effortBaseId = "";
    let effortLevel = "";
    let effortSuffixedId = "";

    const EFFORT_SUFFIX_RE = /-(low|medium|high|max|xhigh)$/;

    beforeAll(async () => {
      const res = await app.fetch(new Request("http://localhost/v1/models"));
      if (!res.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await res.json();
      const ids: string[] = (body.data ?? []).map((m: { id: string }) => m.id);
      const idSet = new Set(ids);
      // Find any suffixed ID whose base also exists in the registry.
      for (const id of ids) {
        const m = EFFORT_SUFFIX_RE.exec(id);
        if (!m) continue;
        const base = id.slice(0, -m[0].length);
        if (idSet.has(base)) {
          effortBaseId = base;
          effortLevel = m[1];
          effortSuffixedId = id;
          break;
        }
      }
    }, 20_000);

    it("accepts a suffixed model ID directly and echoes it back", async () => {
      if (!effortSuffixedId) return; // no effort-capable model on this account
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: effortSuffixedId,
            messages: [
              {
                role: "user",
                content: 'Reply with exactly the word "pong" and nothing else.',
              },
            ],
          }),
        })
      );

      expect(
        response.status,
        `suffixed model ${effortSuffixedId} returned ${response.status}`
      ).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      expect(body.model).toBe(effortSuffixedId);
      expect(body.choices[0].message.role).toBe("assistant");
      expect((body.choices[0].message.content as string).toLowerCase()).toContain("pong");
      expect(body.choices[0].finish_reason).toBe("stop");
    }, 60_000);

    it("rewrites base model + reasoning_effort to the suffixed backend ID and preserves the base ID in the response", async () => {
      if (!effortBaseId) return;
      // Map the discovered Augment level back to an OpenAI effort value.
      // OpenAI accepts: minimal | low | medium | high. "max"/"xhigh" snap
      // down to "high" in resolveEffortModelId; "low"/"medium"/"high" pass
      // through; "minimal" is an alias for the lowest level.
      const openaiEffort =
        effortLevel === "low" || effortLevel === "medium" || effortLevel === "high"
          ? effortLevel
          : "high";

      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: effortBaseId,
            messages: [
              {
                role: "user",
                content: 'Reply with exactly the word "pong" and nothing else.',
              },
            ],
            reasoning_effort: openaiEffort,
          }),
        })
      );

      expect(
        response.status,
        `base ${effortBaseId} + reasoning_effort=${openaiEffort} returned ${response.status}`
      ).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      // Response must echo the original (base) model ID — not the rewritten one.
      expect(body.model).toBe(effortBaseId);
      expect(body.choices[0].message.role).toBe("assistant");
      expect((body.choices[0].message.content as string).toLowerCase()).toContain("pong");
      expect(body.choices[0].finish_reason).toBe("stop");
    }, 60_000);
  });

  // ── POST /v1/messages/count_tokens ───────────────────────────────────────
  describe("POST /v1/messages/count_tokens", () => {
    it("returns a positive estimated input_tokens count", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/messages/count_tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            messages: [{ role: "user", content: "hello world from e2e" }],
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      expect(typeof body.input_tokens).toBe("number");
      expect(body.input_tokens).toBeGreaterThan(0);
    }, 10_000);
  });

  // ── POST /v1/messages (non-streaming) ────────────────────────────────────
  describe("POST /v1/messages (non-streaming)", () => {
    it("returns a real assistant reply with a correct Anthropic message envelope", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            max_tokens: 64,
            messages: [
              {
                role: "user",
                content: 'Reply with exactly the word "pong" and nothing else.',
              },
            ],
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();

      // Envelope
      expect(body.id).toMatch(/^msg_/);
      expect(body.type).toBe("message");
      expect(body.role).toBe("assistant");
      expect(body.model).toBe(testModelId);
      expect(body.stop_reason).toBe("end_turn");
      expect(body.stop_sequence).toBeNull();

      // Content blocks: at least one text block, and the text contains "pong".
      expect(Array.isArray(body.content)).toBe(true);
      expect(body.content.length).toBeGreaterThan(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const textBlocks = body.content.filter((b: any) => b.type === "text");
      expect(textBlocks.length).toBeGreaterThan(0);
      const fullText = textBlocks.map((b: { text: string }) => b.text).join("");
      expect(fullText.toLowerCase()).toContain("pong");

      // Usage — must be real non-zero numbers.
      expect(body.usage.input_tokens).toBeGreaterThan(0);
      expect(body.usage.output_tokens).toBeGreaterThan(0);
    }, 30_000);

    it("honours a system prompt", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            max_tokens: 64,
            system:
              'You are a strict echo bot. Reply with exactly the word "ack" and nothing else.',
            messages: [{ role: "user", content: "hello" }],
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const textBlocks = body.content.filter((b: any) => b.type === "text");
      const fullText = textBlocks.map((b: { text: string }) => b.text).join("");
      expect(fullText.toLowerCase()).toContain("ack");
    }, 30_000);
  });

  // ── Shared Anthropic tool definition (uses input_schema, not parameters) ──
  const anthropicWeatherTool = {
    name: "get_current_weather",
    description: "Get the current weather for a city.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "The city name, e.g. Paris" },
      },
      required: ["city"],
    },
  };

  // ── POST /v1/messages (tool calling, non-streaming) ──────────────────────
  describe("POST /v1/messages (tool calling, non-streaming)", () => {
    it("returns a tool_use content block with the correct Anthropic shape", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            max_tokens: 256,
            messages: [{ role: "user", content: "What is the weather in Paris?" }],
            tools: [anthropicWeatherTool],
            tool_choice: { type: "any" },
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();

      expect(body.id).toMatch(/^msg_/);
      expect(body.type).toBe("message");
      expect(body.model).toBe(testModelId);
      expect(body.stop_reason).toBe("tool_use");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolBlocks = body.content.filter((b: any) => b.type === "tool_use");
      expect(toolBlocks.length).toBeGreaterThan(0);
      const tu = toolBlocks[0];
      expect(typeof tu.id).toBe("string");
      expect(tu.id.length).toBeGreaterThan(0);
      expect(tu.name).toBe("get_current_weather");
      expect(typeof tu.input).toBe("object");
      expect(tu.input).not.toBeNull();
      expect(typeof tu.input.city).toBe("string");
      expect(tu.input.city.length).toBeGreaterThan(0);
    }, 30_000);
  });

  // ── POST /v1/messages (streaming) ────────────────────────────────────────
  describe("POST /v1/messages (streaming)", () => {
    it("delivers a real Anthropic SSE event sequence whose deltas reconstruct a valid reply", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            max_tokens: 64,
            messages: [
              {
                role: "user",
                content: 'Reply with exactly the word "pong" and nothing else.',
              },
            ],
            stream: true,
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      // Drain the SSE stream.
      const bodyStream = response.body;
      if (!bodyStream) throw new Error("Response body is null");
      const reader = bodyStream.getReader();
      const decoder = new TextDecoder();
      let rawSse = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawSse += decoder.decode(value, { stream: true });
      }

      // Parse Anthropic SSE: each event has `event: <type>\ndata: <json>`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const events: any[] = rawSse
        .split("\n\n")
        .map((e) => e.trim())
        .filter(Boolean)
        .map((block) => {
          const dataLine = block
            .split("\n")
            .find((l) => l.startsWith("data: "));
          expect(dataLine, `event missing data line: ${block}`).toBeDefined();
          return JSON.parse((dataLine as string).slice("data: ".length));
        });

      const types = events.map((e) => e.type);
      expect(types[0]).toBe("message_start");
      expect(types).toContain("content_block_start");
      expect(types).toContain("content_block_delta");
      expect(types).toContain("content_block_stop");
      expect(types).toContain("message_delta");
      expect(types.at(-1)).toBe("message_stop");

      // message_start envelope must echo the requested model.
      const start = events[0];
      expect(start.message.id).toMatch(/^msg_/);
      expect(start.message.model).toBe(testModelId);
      expect(start.message.role).toBe("assistant");

      // Reconstruct the full reply from text_delta events.
      const reconstructed = events
        .filter(
          (e) =>
            e.type === "content_block_delta" &&
            e.delta?.type === "text_delta"
        )
        .map((e) => e.delta.text as string)
        .join("");
      expect(reconstructed.length).toBeGreaterThan(0);
      expect(reconstructed.toLowerCase()).toContain("pong");

      // message_delta carries the final stop reason and output token count.
      const messageDelta = events.find((e) => e.type === "message_delta");
      expect(messageDelta.delta.stop_reason).toBe("end_turn");
      expect(typeof messageDelta.usage.output_tokens).toBe("number");
      expect(messageDelta.usage.output_tokens).toBeGreaterThan(0);
    }, 30_000);
  });

  // ── POST /v1/messages (tool calling, streaming) ──────────────────────────
  describe("POST /v1/messages (tool calling, streaming)", () => {
    it("streams tool_use blocks via input_json_delta events with stop_reason=tool_use", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            max_tokens: 256,
            messages: [{ role: "user", content: "What is the weather in Paris?" }],
            tools: [anthropicWeatherTool],
            tool_choice: { type: "any" },
            stream: true,
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      // Drain the SSE stream.
      const bodyStream = response.body;
      if (!bodyStream) throw new Error("Response body is null");
      const reader = bodyStream.getReader();
      const decoder = new TextDecoder();
      let rawSse = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawSse += decoder.decode(value, { stream: true });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const events: any[] = rawSse
        .split("\n\n")
        .map((e) => e.trim())
        .filter(Boolean)
        .map((block) => {
          const dataLine = block
            .split("\n")
            .find((l) => l.startsWith("data: "));
          return JSON.parse((dataLine as string).slice("data: ".length));
        });

      expect(events[0].type).toBe("message_start");
      expect(events.at(-1).type).toBe("message_stop");

      // The tool_use block must open with content_block_start carrying the name.
      const toolStart = events.find(
        (e) =>
          e.type === "content_block_start" &&
          e.content_block?.type === "tool_use"
      );
      expect(toolStart, "no tool_use content_block_start emitted").toBeDefined();
      expect(typeof toolStart.content_block.id).toBe("string");
      expect(toolStart.content_block.id.length).toBeGreaterThan(0);
      expect(toolStart.content_block.name).toBe("get_current_weather");

      // Reconstruct the tool input by concatenating all input_json_delta fragments
      // for the tool block index.
      const toolIdx = toolStart.index;
      const partialJson = events
        .filter(
          (e) =>
            e.type === "content_block_delta" &&
            e.index === toolIdx &&
            e.delta?.type === "input_json_delta"
        )
        .map((e) => e.delta.partial_json as string)
        .join("");
      expect(partialJson.length).toBeGreaterThan(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = JSON.parse(partialJson);
      expect(typeof args.city).toBe("string");
      expect(args.city.length).toBeGreaterThan(0);

      // Final stop_reason must be tool_use.
      const messageDelta = events.find((e) => e.type === "message_delta");
      expect(messageDelta.delta.stop_reason).toBe("tool_use");
    }, 30_000);
  });

  // ── POST /v1/messages (extended thinking → effort suffix) ────────────────
  // Anthropic's `thinking.budget_tokens` is mapped to an OpenAI-style effort
  // (low/medium/high) and rewritten to a suffixed model ID
  // (e.g. claude-opus-4-7-high) when the registry advertises one. The
  // response must echo the original (base) model ID — not the rewritten one.
  describe("POST /v1/messages (extended thinking)", () => {
    let thinkingBaseId = "";

    beforeAll(async () => {
      const res = await app.fetch(new Request("http://localhost/v1/models"));
      if (!res.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await res.json();
      const ids: string[] = (body.data ?? []).map((m: { id: string }) => m.id);
      const idSet = new Set(ids);
      // Find a claude base ID that has at least one effort suffix in the
      // registry — that's what guarantees the rewrite path is exercised.
      for (const id of ids) {
        if (!id.startsWith("claude-")) continue;
        if (/-(low|medium|high|max|xhigh)$/.test(id)) continue;
        if (
          idSet.has(`${id}-high`) ||
          idSet.has(`${id}-medium`) ||
          idSet.has(`${id}-low`)
        ) {
          thinkingBaseId = id;
          break;
        }
      }
    }, 20_000);

    it("accepts thinking config and echoes the base model ID in the response", async () => {
      if (!thinkingBaseId) return; // no effort-capable claude on this account
      const response = await app.fetch(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: thinkingBaseId,
            max_tokens: 1024,
            messages: [
              {
                role: "user",
                content: 'Reply with exactly the word "pong" and nothing else.',
              },
            ],
            // budget_tokens > 16384 → high
            thinking: { type: "enabled", budget_tokens: 32_000 },
          }),
        })
      );

      expect(
        response.status,
        `base ${thinkingBaseId} + thinking returned ${response.status}`
      ).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      // Response must echo the base model, not the suffixed one.
      expect(body.model).toBe(thinkingBaseId);
      expect(body.role).toBe("assistant");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const textBlocks = body.content.filter((b: any) => b.type === "text");
      const fullText = textBlocks.map((b: { text: string }) => b.text).join("");
      expect(fullText.toLowerCase()).toContain("pong");
    }, 60_000);
  });

  // ── POST /v1/responses (non-streaming) ───────────────────────────────────
  describe("POST /v1/responses (non-streaming)", () => {
    it("returns a real assistant reply with the Responses-API envelope", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            input: 'Reply with exactly the word "pong" and nothing else.',
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();

      // Envelope
      expect(body.id).toMatch(/^resp_/);
      expect(body.object).toBe("response");
      expect(body.status).toBe("completed");
      expect(body.error).toBeNull();
      expect(body.model).toBe(testModelId);
      expect(typeof body.created_at).toBe("number");

      // Output: at minimum one assistant message item carrying output_text.
      expect(Array.isArray(body.output)).toBe(true);
      const message = body.output.find(
        (item: { type: string }) => item.type === "message"
      );
      expect(message, "no assistant message in output").toBeDefined();
      expect(message.role).toBe("assistant");
      expect(message.status).toBe("completed");
      const textPart = message.content.find(
        (p: { type: string }) => p.type === "output_text"
      );
      expect(textPart).toBeDefined();
      expect((textPart.text as string).toLowerCase()).toContain("pong");

      // Usage shape: input/output/total tokens, all positive and consistent.
      expect(body.usage.input_tokens).toBeGreaterThan(0);
      expect(body.usage.output_tokens).toBeGreaterThan(0);
      expect(body.usage.total_tokens).toBe(
        body.usage.input_tokens + body.usage.output_tokens
      );
    }, 30_000);

    it("returns a function_call output item when the model calls a tool", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            input: "What is the weather in Paris?",
            tools: [
              {
                type: "function",
                name: "get_current_weather",
                description: "Get the current weather for a city.",
                parameters: {
                  type: "object",
                  properties: {
                    city: { type: "string", description: "The city name" },
                  },
                  required: ["city"],
                },
              },
            ],
            tool_choice: "required",
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      expect(body.status).toBe("completed");

      const call = body.output.find(
        (item: { type: string }) => item.type === "function_call"
      );
      expect(call, "no function_call in output").toBeDefined();
      expect(call.name).toBe("get_current_weather");
      expect(typeof call.call_id).toBe("string");
      expect(call.call_id.length).toBeGreaterThan(0);
      expect(call.status).toBe("completed");
      // Arguments must parse to a JSON object containing `city`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = JSON.parse(call.arguments);
      expect(typeof args.city).toBe("string");
      expect(args.city.length).toBeGreaterThan(0);
    }, 30_000);
  });

  // ── POST /v1/responses (streaming) ───────────────────────────────────────
  describe("POST /v1/responses (streaming)", () => {
    it("delivers the Responses-API SSE lifecycle and reconstructs a valid reply", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            input: 'Reply with exactly the word "pong" and nothing else.',
            stream: true,
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      const events = parseResponsesSse(await drainStream(response));
      expect(events.length).toBeGreaterThan(0);

      // Lifecycle: response.created → response.in_progress → output_item.added
      // → output_text.delta… → output_text.done → content_part.done →
      // output_item.done → response.completed.
      expect(events[0].event).toBe("response.created");
      expect(events[1].event).toBe("response.in_progress");
      expect(events.at(-1)?.event).toBe("response.completed");

      // sequence_number must be strictly monotonic across the whole stream.
      const seqs = events.map((e) => e.data?.sequence_number as number);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBe(seqs[i - 1] + 1);
      }

      const types = events.map((e) => e.event);
      expect(types).toContain("response.output_item.added");
      expect(types).toContain("response.output_text.delta");
      expect(types).toContain("response.output_text.done");
      expect(types).toContain("response.output_item.done");

      // Reconstruct the assistant reply from output_text.delta events.
      const reconstructed = events
        .filter((e) => e.event === "response.output_text.delta")
        .map((e) => (e.data?.delta as string) ?? "")
        .join("");
      expect(reconstructed.toLowerCase()).toContain("pong");

      // Final response.completed must echo the requested model and a real
      // assistant message item with the same text.
      const completed = events.at(-1)?.data?.response;
      expect(completed.status).toBe("completed");
      expect(completed.model).toBe(testModelId);
      expect(completed.usage.input_tokens).toBeGreaterThan(0);
      expect(completed.usage.output_tokens).toBeGreaterThan(0);
      expect(completed.usage.total_tokens).toBe(
        completed.usage.input_tokens + completed.usage.output_tokens
      );
      const message = completed.output.find(
        (item: { type: string }) => item.type === "message"
      );
      expect(message).toBeDefined();
      const textPart = message.content.find(
        (p: { type: string }) => p.type === "output_text"
      );
      expect((textPart.text as string).toLowerCase()).toContain("pong");
    }, 30_000);

    it("streams function_call_arguments deltas and emits a completed function_call item", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            input: "What is the weather in Paris?",
            tools: [
              {
                type: "function",
                name: "get_current_weather",
                description: "Get the current weather for a city.",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
              },
            ],
            tool_choice: "required",
            stream: true,
          }),
        })
      );

      expect(response.status).toBe(200);
      const events = parseResponsesSse(await drainStream(response));
      const types = events.map((e) => e.event);

      expect(types).toContain("response.output_item.added");
      expect(types).toContain("response.function_call_arguments.delta");
      expect(types).toContain("response.function_call_arguments.done");
      expect(types.at(-1)).toBe("response.completed");

      // Reconstruct the arguments from delta events; must parse to a JSON
      // object that contains a `city` field.
      const argsString = events
        .filter((e) => e.event === "response.function_call_arguments.delta")
        .map((e) => (e.data?.delta as string) ?? "")
        .join("");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed: any = JSON.parse(argsString);
      expect(typeof parsed.city).toBe("string");
      expect(parsed.city.length).toBeGreaterThan(0);

      // The completed envelope must carry the function_call output item.
      const completed = events.at(-1)?.data?.response;
      expect(completed.status).toBe("completed");
      const call = completed.output.find(
        (item: { type: string }) => item.type === "function_call"
      );
      expect(call).toBeDefined();
      expect(call.name).toBe("get_current_weather");
      expect(call.status).toBe("completed");
      expect(typeof call.call_id).toBe("string");
      expect(call.call_id.length).toBeGreaterThan(0);
    }, 30_000);
  });
  // ── POST /v1/responses (multi-turn with tool result round-trip) ──────────
  // Exercises the input flattener: a heterogeneous `input` array carrying
  // user message → function_call → function_call_output must be collapsed
  // into the equivalent user/assistant(tool-call)/tool(tool-result) turns
  // before reaching the SDK, so the model can use the result.
  describe("POST /v1/responses (tool result round-trip)", () => {
    it("feeds a function_call_output back to the model and produces a follow-up reply", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            input: [
              { role: "user", content: "What is the weather in Paris?" },
              {
                type: "function_call",
                call_id: "call_e2e_1",
                name: "get_current_weather",
                arguments: '{"city":"Paris"}',
              },
              {
                type: "function_call_output",
                call_id: "call_e2e_1",
                output: '{"temperature_c":21,"summary":"sunny"}',
              },
            ],
            tools: [
              {
                type: "function",
                name: "get_current_weather",
                description: "Get the current weather for a city.",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
              },
            ],
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      expect(body.status).toBe("completed");

      // The model must produce a final assistant message — proving the tool
      // result was actually consumed (rather than re-issuing another call).
      const message = body.output.find(
        (item: { type: string }) => item.type === "message"
      );
      expect(message, "no assistant message in follow-up output").toBeDefined();
      const textPart = message.content.find(
        (p: { type: string }) => p.type === "output_text"
      );
      const text = (textPart.text as string).toLowerCase();
      // The reply should reference the temperature or weather summary we
      // injected. Either signal is acceptable — model wording varies.
      expect(text.length).toBeGreaterThan(0);
      expect(text).toMatch(/sunny|21|paris|warm|weather/);
    }, 60_000);

    it("streams a follow-up reply when a function_call_output is fed back via stream:true", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            stream: true,
            input: [
              { role: "user", content: "What is the weather in Paris?" },
              {
                type: "function_call",
                call_id: "call_e2e_stream_1",
                name: "get_current_weather",
                arguments: '{"city":"Paris"}',
              },
              {
                type: "function_call_output",
                call_id: "call_e2e_stream_1",
                output: '{"temperature_c":21,"summary":"sunny"}',
              },
            ],
            tools: [
              {
                type: "function",
                name: "get_current_weather",
                description: "Get the current weather for a city.",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
              },
            ],
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      const events = parseResponsesSse(await drainStream(response));
      const types = events.map((e) => e.event);

      // Lifecycle invariants.
      expect(types[0]).toBe("response.created");
      expect(types[1]).toBe("response.in_progress");
      expect(types.at(-1)).toBe("response.completed");
      const seqs = events.map((e) => e.data?.sequence_number as number);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBe(seqs[i - 1] + 1);
      }

      // The follow-up turn must produce a streamed assistant message — not
      // another function_call. That proves the tool result was consumed.
      expect(types).toContain("response.output_text.delta");
      const reconstructed = events
        .filter((e) => e.event === "response.output_text.delta")
        .map((e) => (e.data?.delta as string) ?? "")
        .join("");
      expect(reconstructed.length).toBeGreaterThan(0);
      expect(reconstructed.toLowerCase()).toMatch(/sunny|21|paris|warm|weather/);

      // No additional function_call should be emitted on this turn.
      const completed = events.at(-1)?.data?.response;
      expect(completed.status).toBe("completed");
      const newCall = completed.output.find(
        (item: { type: string }) => item.type === "function_call"
      );
      expect(newCall, "follow-up turn unexpectedly emitted another function_call").toBeUndefined();

      // The completed envelope must contain the assistant message whose
      // text equals the reconstructed delta concatenation.
      const message = completed.output.find(
        (item: { type: string }) => item.type === "message"
      );
      expect(message).toBeDefined();
      const textPart = message.content.find(
        (p: { type: string }) => p.type === "output_text"
      );
      expect(textPart.text).toBe(reconstructed);
    }, 60_000);
  });

  // ── POST /v1/responses (instructions field) ──────────────────────────────
  describe("POST /v1/responses (instructions)", () => {
    it("treats top-level instructions as a system prompt and echoes it on the envelope", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            instructions:
              'You are a calculator. Reply with only the digits of the answer, no words, no punctuation.',
            input: "What is 6 times 7?",
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      expect(body.status).toBe("completed");
      // Envelope echoes the instructions verbatim.
      expect(typeof body.instructions).toBe("string");
      expect(body.instructions).toContain("calculator");

      const message = body.output.find(
        (item: { type: string }) => item.type === "message"
      );
      const textPart = message.content.find(
        (p: { type: string }) => p.type === "output_text"
      );
      // The system prompt must have steered the reply: it should contain 42.
      expect((textPart.text as string)).toContain("42");
    }, 30_000);
  });

  // ── POST /v1/responses (reasoning effort → model suffix) ─────────────────
  // Mirrors the chat-completions effort-suffixing test: the proxy rewrites
  // base model + reasoning.effort to the suffixed backend ID and must still
  // echo the base ID back on the response envelope.
  describe("POST /v1/responses (reasoning effort suffixing)", () => {
    let effortBaseId = "";
    let effortLevel = "";

    const EFFORT_SUFFIX_RE = /-(low|medium|high|max|xhigh)$/;

    beforeAll(async () => {
      const res = await app.fetch(new Request("http://localhost/v1/models"));
      if (!res.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await res.json();
      const ids: string[] = (body.data ?? []).map((m: { id: string }) => m.id);
      const idSet = new Set(ids);
      for (const id of ids) {
        const m = EFFORT_SUFFIX_RE.exec(id);
        if (!m) continue;
        const base = id.slice(0, -m[0].length);
        if (idSet.has(base)) {
          effortBaseId = base;
          effortLevel = m[1];
          break;
        }
      }
    }, 20_000);

    it("rewrites base model + reasoning.effort to the suffixed backend ID and preserves the base ID in the response", async () => {
      if (!effortBaseId) return;
      const openaiEffort =
        effortLevel === "low" || effortLevel === "medium" || effortLevel === "high"
          ? effortLevel
          : "high";

      const response = await app.fetch(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: effortBaseId,
            input: 'Reply with exactly the word "pong" and nothing else.',
            reasoning: { effort: openaiEffort },
          }),
        })
      );

      expect(
        response.status,
        `base ${effortBaseId} + reasoning.effort=${openaiEffort} returned ${response.status}`
      ).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      // Envelope must echo the base model and the requested effort.
      expect(body.model).toBe(effortBaseId);
      expect(body.reasoning?.effort).toBe(openaiEffort);
      expect(body.status).toBe("completed");

      const message = body.output.find(
        (item: { type: string }) => item.type === "message"
      );
      const textPart = message.content.find(
        (p: { type: string }) => p.type === "output_text"
      );
      expect((textPart.text as string).toLowerCase()).toContain("pong");
    }, 60_000);
  });

  // ── POST /v1/responses (streaming reasoning) ─────────────────────────────
  // Mirrors the chat-completions reasoning-streaming test. The Augment
  // backend does not always surface THINKING nodes, so we only assert on the
  // reasoning lifecycle when the upstream actually emitted summary deltas —
  // the request itself must always succeed and reconstruct a valid reply.
  describe("POST /v1/responses (streaming reasoning)", () => {
    let reasoningModelId = "";

    beforeAll(async () => {
      const res = await app.fetch(new Request("http://localhost/v1/models"));
      if (!res.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await res.json();
      const ids: string[] = (body.data ?? []).map((m: { id: string }) => m.id);
      reasoningModelId =
        ids.find((id) => id.startsWith("gpt-5")) ??
        ids.find((id) => /thinking|reasoning/.test(id)) ??
        testModelId;
    }, 20_000);

    it("emits a valid lifecycle for reasoning {effort, summary} and surfaces summary deltas when present", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: reasoningModelId,
            input:
              "Think step by step. What is 7 + 5? Reply with only the digits.",
            stream: true,
            reasoning: { effort: "medium", summary: "concise" },
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      const events = parseResponsesSse(await drainStream(response));
      const types = events.map((e) => e.event);

      // Lifecycle invariants hold regardless of whether reasoning surfaced.
      expect(types[0]).toBe("response.created");
      expect(types[1]).toBe("response.in_progress");
      expect(types.at(-1)).toBe("response.completed");
      const seqs = events.map((e) => e.data?.sequence_number as number);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBe(seqs[i - 1] + 1);
      }

      // The model must still produce a valid assistant reply.
      const reconstructed = events
        .filter((e) => e.event === "response.output_text.delta")
        .map((e) => (e.data?.delta as string) ?? "")
        .join("");
      expect(reconstructed.length).toBeGreaterThan(0);

      // When reasoning surfaced, every part of the lifecycle must be valid:
      // added → delta(s) → done part → done item, all carrying the same
      // item_id and a non-empty reconstructed summary.
      const reasoningDeltas = events.filter(
        (e) => e.event === "response.reasoning_summary_text.delta"
      );
      if (reasoningDeltas.length > 0) {
        expect(types).toContain("response.reasoning_summary_part.added");
        expect(types).toContain("response.reasoning_summary_text.done");
        expect(types).toContain("response.reasoning_summary_part.done");

        const summary = reasoningDeltas
          .map((e) => (e.data?.delta as string) ?? "")
          .join("");
        expect(summary.length).toBeGreaterThan(0);

        // The same item_id must be carried across delta and done events.
        const itemId = reasoningDeltas[0].data?.item_id as string;
        expect(typeof itemId).toBe("string");
        expect(itemId.length).toBeGreaterThan(0);
        const doneText = events.find(
          (e) => e.event === "response.reasoning_summary_text.done"
        );
        expect(doneText?.data?.item_id).toBe(itemId);
        expect(doneText?.data?.text).toBe(summary);

        // The completed envelope must include a reasoning output item with
        // a matching summary_text part.
        const completed = events.at(-1)?.data?.response;
        const reasoningItem = completed.output.find(
          (item: { type: string }) => item.type === "reasoning"
        );
        expect(reasoningItem, "no reasoning item in completed output").toBeDefined();
        expect(reasoningItem.id).toBe(itemId);
        expect(reasoningItem.status).toBe("completed");
        const summaryPart = reasoningItem.summary.find(
          (p: { type: string }) => p.type === "summary_text"
        );
        expect(summaryPart.text).toBe(summary);
      }

      // Final completed envelope must carry the requested model and effort.
      const completed = events.at(-1)?.data?.response;
      expect(completed.status).toBe("completed");
      expect(completed.model).toBe(reasoningModelId);
      expect(completed.reasoning?.effort).toBe("medium");
      expect(completed.reasoning?.summary).toBe("concise");
    }, 60_000);
  });
});
