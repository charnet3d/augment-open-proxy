#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HOST, PORT } from "./config";
import chatRouter from "./routes/chat";
import messagesRouter from "./routes/messages";
import modelsRouter from "./routes/models";
import responsesRouter from "./routes/responses";
import { validateCredentials } from "./services/augmentClient";
import { installHttpAgent } from "./services/httpAgent";
import { loggingMiddleware } from "./services/logger";

const app = new Hono();

// Global middleware
app.use("*", cors({
  origin: process.env.CORS_ORIGIN || "*",
}));
app.use("*", loggingMiddleware());

// Health check
app.get("/", (c) => {
  return c.json({
    status: "ok",
    service: "augment-open-proxy",
    version: "1.0.0",
  });
});

// OpenAI-compatible routes
app.route("/v1/chat", chatRouter);
app.route("/v1/models", modelsRouter);
app.route("/v1/responses", responsesRouter);

// Anthropic-compatible routes (Claude Code, Anthropic SDK, etc.)
app.route("/v1/messages", messagesRouter);

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: {
        message: "Not found",
        type: "not_found",
        code: 404,
      },
    },
    404
  );
});

// Start server
async function main() {
  // Install a global undici dispatcher before any fetch happens. The Augment
  // SDK uses Node's global fetch with no timeout overrides, so without this
  // long thinking calls fail with UND_ERR_HEADERS_TIMEOUT after 5 minutes.
  installHttpAgent();

  // Check credentials
  const credentialsValid = await validateCredentials();
  if (!credentialsValid) {
    console.warn(
      "[WARN] No Augment credentials found. Run 'auggie login' or set AUGMENT_API_TOKEN/AUGMENT_API_URL."
    );
  }

  const httpServer = serve(
    { fetch: app.fetch, port: PORT, hostname: HOST },
    () => printBanner()
  );

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    httpServer.close(() => {
      console.log("Server closed.");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function printBanner() {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║     Augment Open Proxy is running                                            ║");
  console.log("╠══════════════════════════════════════════════════════════════════════════════╣");
  console.log(`║  URL:      http://${HOST}:${PORT}`);
  console.log(`║  Chat:      http://${HOST}:${PORT}/v1/chat/completions`);
  console.log(`║  Responses: http://${HOST}:${PORT}/v1/responses`);
  console.log(`║  Messages:  http://${HOST}:${PORT}/v1/messages`);
  console.log(`║  Models:    http://${HOST}:${PORT}/v1/models`);
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝");
  console.log("");
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
