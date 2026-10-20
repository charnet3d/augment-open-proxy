import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { ALLOWED_ORIGINS, API_KEY } from "../config";

/**
 * CORS middleware with an optional origin whitelist. When
 * `AOP_ALLOWED_ORIGINS` is unset, any origin is allowed (prior default
 * behavior). When set, cross-origin requests from origins outside the list
 * are denied the CORS headers — browsers block the response — and a
 * warning is logged so the operator can see what's being blocked.
 */
export function corsMiddleware(): MiddlewareHandler {
  if (ALLOWED_ORIGINS.length === 0) {
    return cors({ origin: "*" });
  }
  return cors({
    origin: (origin) => {
      if (!origin) return undefined;
      if (ALLOWED_ORIGINS.includes(origin)) return origin;
      console.warn(`[security] Blocked cross-origin request from disallowed domain: ${origin}`);
      return undefined;
    },
  });
}

/**
 * Require a matching API key on every request except the `/` health check
 * (so uptime monitors and the Docker healthcheck keep working unauthenticated).
 * Accepts the key via `Authorization: Bearer <key>` or `X-API-Key`. A no-op
 * when `AOP_API_KEY` is unset, preserving the proxy's open-by-default access.
 */
export function apiKeyMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!API_KEY || c.req.path === "/") {
      await next();
      return;
    }
    const authHeader = c.req.header("authorization");
    const bearer = authHeader?.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : undefined;
    const provided = bearer ?? c.req.header("x-api-key");
    if (provided !== API_KEY) {
      return c.json(
        {
          error: {
            message: "Invalid or missing API key",
            type: "authentication_error",
            code: 401,
          },
        },
        401
      );
    }
    await next();
  };
}
