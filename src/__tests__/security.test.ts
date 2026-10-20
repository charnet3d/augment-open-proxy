import { describe, it, expect, afterEach, vi } from "vitest";
import { Hono, type MiddlewareHandler } from "hono";

// `AOP_API_KEY` / `AOP_ALLOWED_ORIGINS` are read once at module-evaluation
// time in src/config.ts, so each test re-imports after setting env vars.
// Empty strings (not `delete`) keep dotenv from reloading the developer's
// local `.env` into the next test — see src/__tests__/logger.test.ts.
async function importSecurity(apiKey?: string, allowedOrigins?: string) {
  vi.resetModules();
  process.env.AOP_API_KEY = apiKey ?? "";
  process.env.AOP_ALLOWED_ORIGINS = allowedOrigins ?? "";
  return await import("../services/security");
}

function buildApp(middleware: MiddlewareHandler) {
  const app = new Hono();
  app.use("*", middleware);
  app.get("/", (c) => c.json({ status: "ok" }));
  app.get("/v1/models", (c) => c.json({ ok: true }));
  return app;
}

describe("security", () => {
  afterEach(() => {
    process.env.AOP_API_KEY = "";
    process.env.AOP_ALLOWED_ORIGINS = "";
  });

  describe("apiKeyMiddleware", () => {
    it("passes every request through when AOP_API_KEY is unset", async () => {
      const { apiKeyMiddleware } = await importSecurity(undefined);
      const app = buildApp(apiKeyMiddleware());
      const res = await app.request("/v1/models");
      expect(res.status).toBe(200);
    });

    it("always allows the / health check, even without a key", async () => {
      const { apiKeyMiddleware } = await importSecurity("secret");
      const app = buildApp(apiKeyMiddleware());
      const res = await app.request("/");
      expect(res.status).toBe(200);
    });

    it("rejects protected routes with no key", async () => {
      const { apiKeyMiddleware } = await importSecurity("secret");
      const app = buildApp(apiKeyMiddleware());
      const res = await app.request("/v1/models");
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { type: string } };
      expect(body.error.type).toBe("authentication_error");
    });

    it("rejects an incorrect key", async () => {
      const { apiKeyMiddleware } = await importSecurity("secret");
      const app = buildApp(apiKeyMiddleware());
      const res = await app.request("/v1/models", {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(res.status).toBe(401);
    });

    it("accepts the key via Authorization: Bearer", async () => {
      const { apiKeyMiddleware } = await importSecurity("secret");
      const app = buildApp(apiKeyMiddleware());
      const res = await app.request("/v1/models", {
        headers: { Authorization: "Bearer secret" },
      });
      expect(res.status).toBe(200);
    });

    it("accepts the key via X-API-Key", async () => {
      const { apiKeyMiddleware } = await importSecurity("secret");
      const app = buildApp(apiKeyMiddleware());
      const res = await app.request("/v1/models", {
        headers: { "X-API-Key": "secret" },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("corsMiddleware", () => {
    it("allows any origin when AOP_ALLOWED_ORIGINS is unset", async () => {
      const { corsMiddleware } = await importSecurity(undefined, undefined);
      const app = buildApp(corsMiddleware());
      const res = await app.request("/v1/models", {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("allows a whitelisted origin", async () => {
      const { corsMiddleware } = await importSecurity(undefined, "https://good.example.com");
      const app = buildApp(corsMiddleware());
      const res = await app.request("/v1/models", {
        headers: { Origin: "https://good.example.com" },
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://good.example.com");
    });

    it("denies and logs a non-whitelisted origin", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { corsMiddleware } = await importSecurity(undefined, "https://good.example.com");
      const app = buildApp(corsMiddleware());
      const res = await app.request("/v1/models", {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("https://evil.example.com")
      );
      warnSpy.mockRestore();
    });
  });
});
