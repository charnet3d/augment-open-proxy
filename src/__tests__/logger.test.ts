import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";

// Each test re-imports the logger module so the LOG_LEVEL / LOG_FORMAT
// constants (read from env at import time) reflect the values set here.
// We assign empty strings rather than `delete`-ing because `src/config.ts`
// calls `dotenv.config()` at module evaluation time; resetModules causes it
// to re-read the developer's local `.env`, which would otherwise leak values
// like `AOP_LOGGING=body` into tests that expect the default. dotenv skips keys
// already present in process.env, and the parsers map "" to the default.
async function importLogger(level: string | undefined, format?: string) {
  vi.resetModules();
  process.env.AOP_LOGGING = level ?? "";
  process.env.AOP_LOG_LEVEL = level ?? "";
  process.env.AOP_LOG_FORMAT = format ?? "";

  // Suppress dotenv's console output during module import
  // (SDK 0.2.0 or its dependencies may emit diagnostics during initialization)
  const originalLog = console.log;
  const originalError = console.error;
  try {
    console.log = () => undefined;
    console.error = () => undefined;
    return await import("../services/logger");
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function lastJsonLine(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> | null {
  const calls = spy.mock.calls;
  if (calls.length === 0) return null;
  const last = calls[calls.length - 1]?.[0];
  if (typeof last !== "string") return null;
  try { return JSON.parse(last); } catch { return null; }
}

describe("logger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
    // See importLogger above — empty strings keep dotenv from reloading
    // the developer's local .env values into the next test.
    process.env.AOP_LOGGING = "";
    process.env.AOP_LOG_LEVEL = "";
    process.env.AOP_LOG_FORMAT = "";
  });

  describe("level parsing", () => {
    it("defaults to info when LOGGING is unset", async () => {
      const { getLogLevel } = await importLogger(undefined);
      expect(getLogLevel()).toBe("info");
    });
    it("accepts none/off/silent as none", async () => {
      for (const v of ["none", "off", "silent"]) {
        const { getLogLevel } = await importLogger(v);
        expect(getLogLevel()).toBe("none");
      }
    });
    it("accepts body/debug/verbose as body", async () => {
      for (const v of ["body", "debug", "verbose"]) {
        const { getLogLevel } = await importLogger(v);
        expect(getLogLevel()).toBe("body");
      }
    });
    it("falls back to info for unknown values", async () => {
      const { getLogLevel } = await importLogger("loud");
      expect(getLogLevel()).toBe("info");
    });
  });

  describe("middleware", () => {
    it("emits one info-level JSON line per request with method, path, status, durationMs", async () => {
      const { loggingMiddleware } = await importLogger("info", "json");
      const app = new Hono();
      app.use("*", loggingMiddleware());
      app.get("/ping", (c) => c.json({ ok: true }));
      const res = await app.request("/ping");
      expect(res.status).toBe(200);
      const rec = lastJsonLine(logSpy);
      expect(rec).toMatchObject({ level: "info", method: "GET", path: "/ping", status: 200 });
      expect(typeof rec?.durationMs).toBe("number");
      expect(rec).not.toHaveProperty("request");
      expect(rec).not.toHaveProperty("response");
    });

    it("emits nothing when LOGGING=none", async () => {
      const { loggingMiddleware } = await importLogger("none");
      const app = new Hono();
      app.use("*", loggingMiddleware());
      app.get("/ping", (c) => c.json({ ok: true }));
      await app.request("/ping");
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("includes parsed request body and response when LOGGING=body", async () => {
      const { loggingMiddleware, attachLogData } = await importLogger("body", "json");
      const app = new Hono();
      app.use("*", loggingMiddleware());
      app.post("/echo", async (c) => {
        const response = { hello: "world" };
        attachLogData(c, { response });
        return c.json(response);
      });
      const res = await app.request("/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ greet: "hi" }),
      });
      expect(res.status).toBe(200);
      const rec = lastJsonLine(logSpy);
      expect(rec?.request).toEqual({ greet: "hi" });
      expect(rec?.response).toEqual({ hello: "world" });
    });

    it("merges fields attached via attachLogData into the final record", async () => {
      const { loggingMiddleware, attachLogData } = await importLogger("info", "json");
      const app = new Hono();
      app.use("*", loggingMiddleware());
      app.post("/g", (c) => {
        attachLogData(c, {
          requestId: "req_42",
          model: "claude-sonnet-4-5",
          effectiveModel: "claude-sonnet-4-5-high",
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        });
        return c.json({});
      });
      await app.request("/g", { method: "POST" });
      const rec = lastJsonLine(logSpy);
      expect(rec).toMatchObject({
        requestId: "req_42",
        model: "claude-sonnet-4-5",
        effectiveModel: "claude-sonnet-4-5-high",
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      });
    });

    it("skips the auto-flush when the handler marks stream:true and lets the handler emit", async () => {
      const { loggingMiddleware, attachLogData, flushLog } = await importLogger("info", "json");
      const app = new Hono();
      app.use("*", loggingMiddleware());
      app.get("/stream", (c) => {
        attachLogData(c, { stream: true, model: "m" });
        // simulate the stream's close path emitting later
        queueMicrotask(() => flushLog(c, 200));
        return c.body("ok");
      });
      await app.request("/stream");
      // wait microtask
      await new Promise((r) => setTimeout(r, 0));
      const calls = logSpy.mock.calls.filter((args: unknown[]) => typeof args[0] === "string");
      expect(calls.length).toBe(1);
      const rec = JSON.parse(calls[0][0] as string);
      expect(rec).toMatchObject({ stream: true, model: "m", status: 200 });
    });
  });

  describe("format selection", () => {
    it("defaults to text when LOG_FORMAT is unset", async () => {
      const { getLogFormat } = await importLogger("info");
      expect(getLogFormat()).toBe("text");
    });
    it("accepts json as json", async () => {
      const { getLogFormat } = await importLogger("info", "json");
      expect(getLogFormat()).toBe("json");
    });
    it("accepts text as text", async () => {
      const { getLogFormat } = await importLogger("info", "text");
      expect(getLogFormat()).toBe("text");
    });
    it("falls back to text for unknown format values", async () => {
      const { getLogFormat } = await importLogger("info", "yaml");
      expect(getLogFormat()).toBe("text");
    });

    it("emits a human-readable single line at info level when LOG_FORMAT=text", async () => {
      const { loggingMiddleware, attachLogData } = await importLogger("info", "text");
      const app = new Hono();
      app.use("*", loggingMiddleware());
      app.post("/v1/x", (c) => {
        attachLogData(c, {
          requestId: "req_1",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        });
        return c.json({});
      });
      await app.request("/v1/x", { method: "POST" });
      const line = logSpy.mock.calls.at(-1)?.[0] as string;
      expect(typeof line).toBe("string");
      expect(line.startsWith("[")).toBe(true);
      expect(line).toContain("INFO POST /v1/x 200");
      expect(line).toContain("model=claude-sonnet-4-5");
      expect(line).toContain("req=req_1");
      expect(line).toContain("tokens=10/20/30");
      // Not JSON
      expect(() => JSON.parse(line)).toThrow();
    });

    it("appends request and response on indented continuation lines at body level when LOG_FORMAT=text", async () => {
      const { loggingMiddleware, attachLogData } = await importLogger("body", "text");
      const app = new Hono();
      app.use("*", loggingMiddleware());
      app.post("/v1/y", (c) => {
        attachLogData(c, { response: { ok: 1 } });
        return c.json({ ok: 1 });
      });
      await app.request("/v1/y", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: "hi" }),
      });
      const line = logSpy.mock.calls.at(-1)?.[0] as string;
      expect(line).toContain('\n  request: {"q":"hi"}');
      expect(line).toContain('\n  response: {"ok":1}');
    });
  });
});
